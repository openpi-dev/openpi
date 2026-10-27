These production WebHost screenshots use the synthetic provider-error fixture in `tests/web/openpi-web.e2e.ts`, not private Session data.

They show localized concurrency-limit guidance, collapsed original error details, and the existing manual retry action at desktop and narrow widths. Automatic retry is tested separately with real Pi AgentSession fixtures, including retry disabled, exhausted retry budgets and cancellation. The streaming identity regression interleaves a custom message with eight updates of one write call and fails against the previous commit.

Source issue: https://github.com/openpi-dev/openpi/issues/910
Implementation: https://github.com/openpi-dev/openpi/pull/909
