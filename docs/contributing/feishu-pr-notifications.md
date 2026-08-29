# Feishu PR notifications

The Feishu group bot notification is handled by `.github/workflows/feishu-pr-notification.yml`.

To enable it:

1. Enable **Signature Verification** (加签) in the Feishu group bot's security settings and copy the signing secret.
2. In the GitHub repository, open **Settings > Secrets and variables > Actions**.
3. Add `FEISHU_PR_BOT_WEBHOOK` with the bot's webhook URL.
4. Add `FEISHU_PR_BOT_SECRET` with the bot's signing secret.

The workflow skips notifications when neither secret exists and fails when only one is configured. The webhook URL and signing secret are never included in the message or logs.

The workflow runs when a pull request is opened or marked ready for review. It uses `pull_request_target` so the repository secret is available for PRs from forks, but it does not check out or execute pull request code.
