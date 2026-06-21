// 跨模块共享的小常量。这里只放纯数据，不依赖任何运行时状态。

// 真执行工具名（成员可被授予的工具白名单）
const REAL_TOOL_NAMES = ["shell", "write_file", "read_file", "edit_file", "list_dir", "web_fetch"];

// Harness 主控 / 调度相关常量
const ORCH_ID = "__orchestrator__";
const HARNESS_MAX_ROUNDS = 48;
const HARNESS_MAX_MEMBER_CALLS = 3;
const HARNESS_MAX_PARALLEL = 8;
const HARNESS_DECISION_TOOL = "submit_harness_decision";
const HARNESS_UPDATE_TEAM_TOOL = "update_team";

module.exports = {
  REAL_TOOL_NAMES,
  ORCH_ID, HARNESS_MAX_ROUNDS, HARNESS_MAX_MEMBER_CALLS, HARNESS_MAX_PARALLEL,
  HARNESS_DECISION_TOOL, HARNESS_UPDATE_TEAM_TOOL,
};
