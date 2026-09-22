import type { WebQuestions } from "../../web/protocol/questions.ts";

export const questionFixture: WebQuestions = [
  {
    id: "scope",
    header: "实现范围",
    question: "你希望这次实现覆盖到什么范围？",
    options: [
      {
        label: "完整交互（推荐）",
        description: "提供选项、自定义回答和提交前复核，保持当前会话。",
        preview: "提问 → 选择 → 复核 → 继续",
      },
      {
        label: "先完成基础选择",
        description: "先验证选项回传，稍后再完善交互。",
      },
    ],
  },
  {
    id: "validation",
    header: "验收方式",
    question: "你希望怎样验证结果？",
    options: [
      {
        label: "自动测试与浏览器验收",
        description: "覆盖运行状态，并检查实际界面。",
      },
      { label: "先看界面", description: "先检查样式和操作流程。" },
    ],
  },
];
