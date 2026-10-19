# Apply the v2 revision to GitHub from Windows

The source ZIP is complete and can run independently. The companion patch is based on repository commit `b9eafa0128f7f62b7de45db43f8f8b2e81f6c0cc` and includes additions, edits and the new database migration. It does not include personal data, credentials, `.git`, or dependencies.

Save `canvasly-v2.patch` in Downloads, then use a **new** checkout so you do not overwrite uncommitted work:

```cmd
cd %USERPROFILE%\Downloads
git clone https://github.com/shlbi/canvasly.git canvasly-v2-update
cd canvasly-v2-update
git apply --check ..\canvasly-v2.patch
git apply ..\canvasly-v2.patch
npm ci
npm run check
```

Stop if `git apply --check` fails. That means this patch needs reconciling with the checkout; do not force an overwrite or reset your history. Inspect `git status` and the changes before publishing.

```cmd
git add .
git commit -m "Rebuild Canvasly around the student agent, shared context and ChatGPT access"
git push origin main
```

These are publication steps for you to run, not a statement that the revision has already been pushed. Do not force-push. Your own GitHub authentication is required. Configure integrations and validate approved provider flows separately; publication alone does not finish the external setup.
