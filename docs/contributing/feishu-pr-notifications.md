# Feishu PR notifications

The Feishu group bot notification is triggered by `.github/workflows/feishu-pr-notification.yml`. The caller follows the reusable implementation on the [`openpi-dev/automation`](https://github.com/openpi-dev/automation) `main` branch.

To enable it:

1. Enable **Signature Verification** (加签) in the Feishu group bot's security settings and copy the signing secret.
2. In the GitHub repository, open **Settings > Secrets and variables > Actions**.
3. Add `FEISHU_PR_BOT_WEBHOOK` with the bot's webhook URL.
4. Add `FEISHU_PR_BOT_SECRET` with the bot's signing secret.

The workflow skips notifications when neither secret exists and fails when only one is configured. The webhook URL and signing secret are never included in the message or logs.

The workflow runs when a pull request is opened or marked ready for review. It uses `pull_request_target` so the repository secret is available for PRs from forks. The repository caller passes only the two Feishu secrets to the reusable workflow; neither workflow checks out or executes pull request code.

Notifications are event-driven: if an author moves a pull request back to draft and then marks it ready again, the group receives another notification.
