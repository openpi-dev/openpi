These screenshots use public synthetic fixtures from `tests/web/subagent-inspection.e2e.ts` through the production WebHost/static build, not private Session data.

They verify the #907 regression: completed nested read and bash rows retain the requested filename and command while returned file contents and `200 7867` stay inside expandable results. The browser cases cover desktop mouse, narrow mouse, and narrow touch input; the screenshot files show desktop and narrow mouse layouts.

Source issue: https://github.com/openpi-dev/openpi/issues/907
