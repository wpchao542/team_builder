// 跨模块共享的小常量。这里只放纯数据，不依赖任何运行时状态。

// 真执行工具名（成员可被授予的工具白名单）
const REAL_TOOL_NAMES = ["shell", "write_file", "read_file", "edit_file", "list_dir", "web_fetch"];

module.exports = { REAL_TOOL_NAMES };
