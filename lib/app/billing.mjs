import { createHmac, createHash } from 'node:crypto';
import { AppError, requireValue } from '../security.mjs';
import { appOrigin, equalSecret } from './config.mjs';

/** Small instance-scoped Stripe REST adapter; no SDK global credentials or browser secret exposure. */
export class StripeClient {
  /** Keep the transport injectable and the account key server-only. */
  constructor(fetchImpl = fetch) { this.fetch = fetchImpl; }

  /** Call Stripe with a pinned API version and idempotency for retryable resource creation. */
  async call(path, fields, idempotencyKey) {
    const response = await this.fetch(`https://api.stripe.com/v1/${path}`, {
      method: fields ? 'POST' : 'GET', headers: {
        Authorization: `Bearer ${requireValue('STRIPE_SECRET_KEY')}`, 'Stripe-Version': '2026-08-26.dahlia',
        ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
      }, ...(fields ? { body: new URLSearchParams(fields).toString() } : {}), redirect: 'error', signal: AbortSignal.timeout(18000)
    });
    const data = await response.json();
    if (!response.ok) throw new AppError('Billing provider unavailable. Check the Stripe configuration or retry.', 502);
    return data;
  }
}

/** Verify the signature over original bytes and a recent timestamp, supporting key rotation signatures. */
export function verifyStripe(raw, header, secret, now = Date.now()) {
  const entries = String(header || '').split(',');
  const timestamp = entries.find(/* Find the signed timestamp, not an arbitrary request date. */ value => value.startsWith('t='))?.slice(2);
  if (!/^\d+$/.test(timestamp || '') || Math.abs(now / 1000 - Number(timestamp)) > 300) throw new AppError('Invalid webhook signature.', 400);
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
  if (!entries.some(/* Stripe may send several v1 signatures during secret rotation. */ value => value.startsWith('v1=') && equalSecret(value.slice(3), expected))) throw new AppError('Invalid webhook signature.', 400);
  let event; try { event = JSON.parse(raw.toString('utf8')); } catch { throw new AppError('Invalid webhook payload.'); }
  if (!event.id || !event.type || !event.data?.object) throw new AppError('Invalid webhook event.');
  return event;
}

/** Return a Stripe customer owned by this verified user; idempotency protects concurrent signups. */
export async function stripeCustomer(store, user, stripe = new StripeClient()) {
  const rows = await store.db(`canvasly_customers?user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
  if (rows[0]) return rows[0].stripe_customer_id;
  const customer = await stripe.call('customers', { email: user.email }, `canvasly-customer-${user.id}`);
  await store.db('canvasly_customers?on_conflict=user_id', 'POST', { user_id: user.id, stripe_customer_id: customer.id }, 'resolution=ignore-duplicates,return=minimal');
  return (await store.db(`canvasly_customers?user_id=eq.${encodeURIComponent(user.id)}&limit=1`))[0].stripe_customer_id;
}

/** Create the one supported $20 USD/month checkout, rejecting accidental wrong-price configuration. */
export async function checkout(store, user, stripe = new StripeClient()) {
  const current = await store.billing(user.id);
  if (current.active) throw new AppError('Your subscription is already active. Use Manage subscription.', 409);
  const priceId = requireValue('STRIPE_PRICE_ID');
  if (!/^price_[A-Za-z0-9]+$/.test(priceId)) throw new AppError('Invalid Stripe price configuration.', 503);
  const price = await stripe.call(`prices/${priceId}`);
  if (!price.active || price.currency !== 'usd' || price.unit_amount !== 2000 || price.recurring?.interval !== 'month' || price.recurring?.interval_count !== 1) throw new AppError('Configure an active $20 USD monthly Stripe price before accepting subscriptions.', 503);
  const customer = await stripeCustomer(store, user, stripe);
  const window = Math.floor(Date.now() / 600000);
  const suffix = [...createHash('sha256').update(`${user.id}:${window}`).digest().subarray(0, 8)].map(/* Keep the payload stable for repeated idempotent requests. */ byte => String.fromCharCode(97 + byte % 26)).join('');
  // Repeated clicks in the same short window reuse one session; no hidden trial or extra charge.
  const session = await stripe.call('checkout/sessions', {
    mode: 'subscription', customer, 'line_items[0][price]': priceId, 'line_items[0][quantity]': '1',
    success_url: `${appOrigin()}/?checkout=success#billing`, cancel_url: `${appOrigin()}/#billing`,
    integration_identifier: `canvasly-${suffix}`
  }, `canvasly-checkout-${user.id}-${window}`);
  return { url: session.url };
}

/** Open the customer's Stripe-hosted portal for cancellation, invoices and payment-method changes. */
export async function portal(store, user, stripe = new StripeClient()) {
  const customer = await stripeCustomer(store, user, stripe);
  const session = await stripe.call('billing_portal/sessions', { customer, return_url: `${appOrigin()}/#billing` });
  return { url: session.url };
}

/** Extract subscription IDs across current invoice and checkout object shapes. */
export function eventSubscription(event) {
  const object = event.data.object;
  const value = event.type.startsWith('customer.subscription.') ? object.id : object.subscription || object.parent?.subscription_details?.subscription;
  return typeof value === 'object' ? value.id : value;
}

/** Reconcile verified events from Stripe's current subscription object, never from browser redirects. */
export async function applyWebhook(store, raw, signature, stripe = new StripeClient()) {
  const event = verifyStripe(raw, signature, requireValue('STRIPE_WEBHOOK_SECRET'));
  const relevant = event.type.startsWith('customer.subscription.') || ['checkout.session.completed','checkout.session.async_payment_succeeded','invoice.paid','invoice.payment_failed'].includes(event.type);
  if (!relevant) return { received: true };
  const subscriptionId = eventSubscription(event);
  if (!subscriptionId || !/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) return { received: true };
  const subscription = await stripe.call(`subscriptions/${subscriptionId}`);
  const customerId = typeof subscription.customer === 'object' ? subscription.customer.id : subscription.customer;
  const owner = (await store.db(`canvasly_customers?stripe_customer_id=eq.${encodeURIComponent(customerId)}&limit=1`))[0];
  if (!owner) throw new AppError('Subscription owner is not mapped yet. Stripe should retry this event.', 503);
  const item = subscription.items?.data?.[0];
  const priceId = item?.price?.id;
  const start = subscription.current_period_start || item?.current_period_start;
  const end = subscription.current_period_end || item?.current_period_end;
  if (!start || !end) throw new AppError('Subscription period unavailable. Stripe should retry.', 503);
  await store.rpc('canvasly_apply_subscription', {
    p_event: event.id, p_created: event.created, p_user: owner.user_id, p_subscription: subscriptionId,
    p_price: priceId || '', p_status: priceId === requireValue('STRIPE_PRICE_ID') ? subscription.status : 'unsupported_price',
    p_start: new Date(start * 1000).toISOString(), p_end: new Date(end * 1000).toISOString(), p_cancel: subscription.cancel_at_period_end === true
  });
  return { received: true };
}
