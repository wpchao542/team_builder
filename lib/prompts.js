// 点将台的全部「提示词 / JSON Schema」纯数据常量。
// 这里只放静态文本与 schema，不含任何运行时逻辑或可变状态，便于单独维护与审阅。

// ---------- 点将：基础团队设计 ----------
const DESIGN_SYSTEM = `你是「点将台」的首席团队架构师。用户用自然语言描述一个目标或任务，你为它组建一支 AI agent 团队。

要求：
1. 设计 3~8 个 agent，各有清晰分工，避免职责重叠。
2. 团队用一张有向无环图展示建议协作结构：每个 agent 的 depends_on 列出通常会给它提供产出的同事（用对方的 id）。没有建议上游就留空数组。DAG 用于界面层级与作战状态展示，运行时由团队主 Agent 动态控制成员。
3. **团队要有真实的层级结构**：像一家公司——前线成员产出原料，中层（小组长/主笔/统稿人等）聚合自己负责的几条线再向上交付，最后才到收尾人。依赖链路至少 3 层（前线 → 中层 → 收尾）。**禁止所有成员都直接挂在同一个收尾人身上**（那是星形，不是团队）。
4. 必须有且只有一个"收尾" agent（没有任何人依赖它），负责整合直接下属的产出，输出最终交付物。
5. 每个 agent：
   - id: 小写英文标识（字母数字连字符）
   - name: 优先使用贴合职责的军队或军帐风格中文称号，如斥候、参军、校尉、主簿、先锋、军需官、督军等；要易懂、不浮夸，只能写名字文字，禁止包含 emoji、图标或装饰符号
   - emoji: 一个代表性 emoji，是界面显示的唯一成员图标；名字旁想用的图标必须只写在这里
   - role: 职位/职责一句话
   - persona: 性格与做事风格，1~2 句
   - system_prompt: 这个 agent 的完整系统提示词，200~400 字。要包含：身份与专长、性格与表达风格、具体职责、对输出的明确要求（结构、深度、格式）。写得让它能独立胜任工作。
   - tools: 该成员可调用的真执行工具名数组（见下）。纯创意/策划/写作成员留空数组 []；只有需要真正动手产出文件或跑命令行的成员才授予工具。
   - model: 留空字符串 ""（默认继承将军模型）。将军与每个成员子 Agent 都可以使用不同模型，但默认不要乱填，交给用户在界面上按需调。
   - risk: 由你在点将阶段判断该成员职责是否包含高危操作。不要靠关键词机械判断，要理解成员真实职责、system_prompt 与工具权限：
     * level: "none" 或 "danger"
     * summary: level 为 danger 时用一句话说明危险点；否则空字符串
     * operations: level 为 danger 时列出 1~5 条具体危险操作（如删除文件、销毁资源、清空数据、覆盖生产文件等）；否则 []
     只有成员职责明确包含删除、销毁、清空、覆盖不可恢复数据/文件/资源等真实破坏性动作时才标 danger；普通读取、写新文件、生成稿件、渲染、分析不要标。
6. team_name 简短有力，summary 用一段话说明团队如何分层协作完成该任务。
7. system_prompt 里不要提到"等待上游输入"之类的流程细节——运行时会自动把上游产出交给它。
8. 可授予的工具目录（只能从这里选，不要发明新工具）：
   - "shell"：执行 shell 命令（curl 调 ElevenLabs 配音、ffmpeg 合成/倍速视频、whisper 对时、puppeteer 渲帧、dreamina CLI 出图，或经 mcporter 调 MCP）
   - "write_file"：把内容写入工作目录的文件（如口播稿.md、cover.html、渲染脚本）
   - "read_file"：读取工作目录里的文件
   原则：能"真出片/真出图/真写文件"的执行型成员才给工具；负责构思、文案、策划的成员给 []。给了 shell 的成员通常也一并给 write_file 和 read_file。`;

const TEAM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["team_name", "emoji", "summary", "agents"],
  properties: {
    team_name: { type: "string" },
    emoji: { type: "string" },
    summary: { type: "string" },
    agents: {
      type: "array",
      minItems: 3,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "emoji", "role", "persona", "system_prompt", "depends_on", "risk"],
        properties: {
          id: { type: "string", description: "小写英文标识" },
          name: { type: "string", description: "优先使用贴合职责、易懂的军队或军帐风格纯文字成员名，禁止包含 emoji、图标或装饰符号" },
          emoji: { type: "string", description: "恰好一个代表性 emoji，作为该成员唯一显示图标" },
          role: { type: "string" },
          persona: { type: "string" },
          system_prompt: { type: "string" },
          depends_on: { type: "array", items: { type: "string" } },
          tools: {
            type: "array",
            description: "该成员可调用的真执行工具名（来自固定目录），不需要执行就留空数组",
            items: { type: "string", enum: ["shell", "write_file", "read_file"] },
          },
          model: {
            type: "string",
            description: "该成员单独使用的模型 id（如 claude-opus-4-8 / minimax-m3:cloud）。留空字符串则用系统默认模型。",
          },
          risk: {
            type: "object",
            additionalProperties: false,
            required: ["level", "summary", "operations"],
            description: "点将模型对该成员危险程度的结构化判断；只在真实职责包含删除/销毁/清空/覆盖不可恢复资源时标 danger。",
            properties: {
              level: { type: "string", enum: ["none", "danger"] },
              summary: { type: "string" },
              operations: { type: "array", items: { type: "string" }, maxItems: 5 },
            },
          },
        },
      },
    },
    secrets: {
      type: "array",
      description: "团队级凭证：仅在导入 skill 时，把 skill 原文里真实出现的 API key/凭证提取到这里（普通点将留空数组）。",
      items: {
        type: "object", additionalProperties: false, required: ["key", "value"],
        properties: { key: { type: "string", description: "环境变量名，如 ELEVENLABS_API_KEY" }, value: { type: "string", description: "凭证值" } },
      },
    },
  },
};

// ---------- 作战蓝图（勘察阶段） ----------
const PLATFORM_CATALOG = `# 可选外部平台目录（推荐时优先从这里选，并讲清理由；这件事纯靠模型就能完成、不需要外部平台时给空数组）
- 配音 / TTS：ElevenLabs（多语种、音色克隆，质量高，需 ELEVENLABS_API_KEY）｜MiniMax 语音（中文自然，需 DASHSCOPE_API_KEY）｜OpenAI TTS
- 文生图 / 出图：即梦 Dreamina（中文海报、分镜强）｜可灵 Kling｜Stable Diffusion（本地）
- 文生视频 / 对口型：可灵 Kling｜Runway｜即梦
- 视频合成 / 剪辑：ffmpeg（本地，走 shell）｜剪映草稿
- 语音转写 / 对时：Whisper（本地，走 shell）
- 渲染 / 截帧：Puppeteer（本地 headless Chrome，走 shell）
- 网络检索 / 资料：Web 搜索｜官方文档抓取
- 代码 / 部署：本地 shell｜GitHub
- 已接入的 MCP 工具：经 mcporter 调用对应 MCP server`;

const BLUEPRINT_SYSTEM = `你是「点将台」的首席方案架构师。用户只给一句话，但你不能直接拉一堆人来写文章——你要先像 Claude 接到任务时那样，把这件事想清楚并讲给用户听，再去组队。

你的产物是一份【作战蓝图】，必须包含：
1. goal：把用户这句话还原成清晰、可执行的目标（补全隐含意图，但不要擅自扩大范围）。
2. tasks：把目标拆成 2~7 个具体任务，写明先后或并行关系。每个任务写 title、detail（具体做什么、产出什么真实产物）、acceptance（验收标准：怎样算这步做对了）。任务要落到真实产出（文件、图、音频、视频、数据、代码等），不要"写一篇文章"这种空话。
3. tools_needed：完成这些任务真正需要的执行工具（shell / write_file / read_file），每条说明为什么需要、用在哪个任务。纯靠模型构思就能完成的别硬塞工具。
4. external_platforms：需要调用的外部平台 / 服务。每条给出 capability（要解决什么）、recommended（你最推荐哪个）、alternatives（其他可选）、why（为什么推荐它）、needs_credential（是否需要凭证）、env_key（需要凭证时给出环境变量名，否则空字符串）。从下面目录里选并讲清理由；纯靠模型自身就能完成、不需要外部平台时给空数组。
5. open_questions：你需要用户拍板或补充才能继续的关键问题（风格偏好、目标平台、是否已有素材、时长 / 预算等）。每条给 question 和 why（为什么这个问题会影响方案）。宁可问，也不要替用户瞎猜。

${PLATFORM_CATALOG}

像一个会沟通的资深主理人那样思考：先把"这句话其实要做哪些事、要配哪些工具、建议接哪些平台、还有哪些得你定"讲清楚，把决策权交还给用户。只输出符合 schema 的 JSON。`;

const BLUEPRINT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["goal", "tasks", "tools_needed", "external_platforms", "open_questions"],
  properties: {
    goal: { type: "string", description: "把用户一句话还原成的清晰可执行目标" },
    tasks: {
      type: "array", minItems: 1, maxItems: 9,
      items: {
        type: "object", additionalProperties: false,
        required: ["title", "detail", "acceptance"],
        properties: {
          title: { type: "string" },
          detail: { type: "string", description: "这一步具体做什么、产出什么真实产物" },
          acceptance: { type: "string", description: "验收标准：怎样算这步做对了" },
        },
      },
    },
    tools_needed: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["tool", "why"],
        properties: {
          tool: { type: "string", enum: ["shell", "write_file", "read_file"] },
          why: { type: "string", description: "为什么需要、用在哪个任务" },
        },
      },
    },
    external_platforms: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["capability", "recommended", "alternatives", "why", "needs_credential", "env_key"],
        properties: {
          capability: { type: "string", description: "要解决什么能力（如配音、出图、渲帧）" },
          recommended: { type: "string", description: "最推荐的那个平台" },
          alternatives: { type: "array", items: { type: "string" } },
          why: { type: "string", description: "为什么推荐它" },
          needs_credential: { type: "boolean" },
          env_key: { type: "string", description: "需要凭证时的环境变量名，否则空字符串" },
        },
      },
    },
    open_questions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["question", "why"],
        properties: {
          question: { type: "string" },
          why: { type: "string", description: "为什么这个问题会影响方案" },
        },
      },
    },
  },
};

// ---------- 点兵：按已确认蓝图组队 ----------
const STAFF_SYSTEM = `你是「点将台」的首席团队架构师。用户已经和你一起把一份【作战蓝图】确认好了——目标、任务清单（含验收标准）、要用的工具、要接的外部平台，以及用户对若干关键问题的拍板。现在请严格按这份已确认的蓝图组建执行团队。

落地蓝图（最高优先级）：
1. 团队必须覆盖蓝图里的每一个任务：每个任务至少由一名成员负责，成员的 role 要写清它负责蓝图里的哪个任务、对应的验收标准是什么。不要新增蓝图之外的工作，也不要漏掉任务。
2. 工具按蓝图 tools_needed 授予——只有真正要跑命令 / 读写文件 / 调外部平台的成员才给 shell / write_file / read_file；纯策划、撰写的成员给 []。
3. 用户已确认的外部平台要写进相关成员的 system_prompt：写明用哪个平台、怎么调；凭证由系统通过环境变量注入，提示词里只引用 env_key 名（如 \${ELEVENLABS_API_KEY}），绝不要写死真实 key。
4. 用户对 open_questions 的回答是硬约束，必须体现在对应成员的职责与提示词里。

团队结构要求：
5. 设计 3~8 个 agent，各有清晰分工，避免职责重叠；团队要有真实层级（前线产出 → 中层聚合 → 收尾整合），依赖链至少 3 层，禁止所有人都直接挂在同一个收尾人身上。
6. 必须有且只有一个"收尾"agent（没有任何人依赖它），整合直接下属产出，输出最终交付物。
7. 每个 agent：id（小写英文）；name（优先使用贴合职责、易懂的军队或军帐风格中文称号，如斥候、参军、校尉、主簿、先锋、军需官、督军等，禁止含 emoji / 图标）；emoji（一个代表性 emoji，界面唯一图标）；role（一句话职责，点明负责的蓝图任务）；persona（性格风格 1~2 句）；system_prompt（200~400 字完整系统提示词：身份专长、性格、具体职责、对输出结构 / 深度 / 格式的明确要求，并落实其负责任务的验收标准）；tools（真执行工具名数组，纯创意成员留 []）；model（留空字符串继承将军模型）。depends_on 列出通常给它供料的同事 id，没有就留空数组。
8. team_name 简短有力，summary 一段话说明团队如何分层协作完成蓝图目标。system_prompt 里不要提"等待上游输入"之类流程细节——运行时会自动把上游产出交给它。
9. 工具目录只能从这三个选，不要发明：shell（跑命令，如 curl 调配音、ffmpeg 合成、puppeteer 渲帧）、write_file（写产物文件）、read_file（读工作目录文件）；给了 shell 的成员通常一并给 write_file 和 read_file。`;

// ---------- 导入 skill 点将：只做团队范式拆分 ----------
const SKILL_DESIGN_SYSTEM = `你是「点将台」的团队拆分员。用户给你一套【已经调试好、测试通过的 skill】（一个或多个）。你的权限仅限于把原流程映射成团队成员和依赖图，不得重新设计、优化、改写或补充 skill 的功能。

怎么做：
1. 拆分单位是 skill 原文里的【独立功能模块】，不是行号、不是段落长度、不是任意切片。通读整套 skill 和“功能模块纲要”，识别原文中已经存在的阶段、角色、并行关系、确认点、输入输出和交接顺序。
2. 每个成员必须负责一个或多个完整功能模块，并在 module_refs 中填写这些模块 id。紧密耦合、不可独立交付的模块可以合并给同一成员；一个不可拆的原子模块不能拆成多个成员；不要创造原文没有的新功能模块。
3. 团队结构必须语义映射这些原始模块，不能为了团队好看而新增、删除、合并、调序或改造任何步骤。若原流程本来有多个并行终点，不要强行添加新的收尾步骤。
4. name / emoji / persona 可以做团队化包装；name 优先使用贴合职责、易懂的军队或军帐风格称号，如斥候、参军、校尉、主簿、先锋、军需官、督军等；role 必须明确写出该成员负责的原始功能模块和交付物，禁止留空，禁止写“完成分内工作”“执行任务”等空话。
5. system_prompt 写该成员在团队中的职责边界、输入、输出和交付标准，但不得重新发明原 skill 的功能；需要引用原始规则时用“遵守团队全局 Skill 中的原始规则”表达，不要切分、摘抄或改写原文。
6. depends_on 表示 DAG 展示上游：按原 skill 的实际模块顺序、并行关系和交付关系填写；如果不确定，保持模块顺序即可，不要编造不存在的强依赖。
7. tools：需要真正跑命令行 / 读写文件的成员才给 shell / write_file / read_file，纯策划/撰写给 []。
8. risk：由你在拆分阶段判断该成员职责是否包含高危操作。不要靠关键词机械判断，要理解成员真实职责、原始 skill 语义与工具权限。只有成员职责明确包含删除、销毁、清空、覆盖不可恢复数据/文件/资源等真实破坏性动作时才标 {level:"danger"}，并在 summary / operations 中简要说明；普通读取、写新文件、生成稿件、渲染、分析不要标。
9. 凭证提取：如果 skill 原文里出现了 API key / 凭证（如 sk- 开头的 key、xi-api-key、各种 *_API_KEY、token 等），把它们提取到团队顶层的 secrets 数组，每条 {key: 环境变量名（如 ELEVENLABS_API_KEY）, value: 真实值}。只提取 skill 里真实出现的，不要编造；没有就给空数组。
10. team_name 与 summary：summary 提炼这套 skill 是做什么的、最终交付什么。
11. 成员图标规则：name 只能是纯文字名字，禁止包含 emoji、图标或装饰符号；emoji 字段填写恰好一个代表性 emoji，作为界面显示的唯一成员图标。军队风格只用于称谓包装，不得改变原始 skill 的任何功能、步骤或执行要求。
12. 原文忠实性是最高规则：用户附加说明只能补充本次团队命名或分工偏好，不得覆盖、修改或“优化”原 skill。

总之：你只画组织结构，不碰生产配方。`;

const SKILL_TEAM_SCHEMA = JSON.parse(JSON.stringify(TEAM_SCHEMA));
SKILL_TEAM_SCHEMA.properties.agents.minItems = 1;
SKILL_TEAM_SCHEMA.properties.agents.maxItems = 24;
SKILL_TEAM_SCHEMA.properties.agents.items.required = [
  ...new Set([...SKILL_TEAM_SCHEMA.properties.agents.items.required, "module_refs"]),
];
SKILL_TEAM_SCHEMA.properties.agents.items.properties.module_refs = {
  type: "array",
  minItems: 1,
  description: "该成员负责的独立功能模块 id，必须来自用户提供的功能模块纲要；不要填行号或自造 id。",
  items: { type: "string" },
};
SKILL_TEAM_SCHEMA.properties.agents.items.properties.role.description =
  "明确的原始功能模块职责和交付物；禁止空话，禁止写完成分内工作";
SKILL_TEAM_SCHEMA.properties.agents.items.properties.system_prompt.description =
  "写清成员职责边界、输入、输出与交付标准；必须遵守团队全局 Skill 中完整原文，不要切分、摘抄或改写原始 skill。";

// ---------- 对话式改成员 ----------
const EDIT_AGENT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["name", "emoji", "role", "persona", "system_prompt", "tools", "_changed"],
  properties: {
    name: { type: "string" }, emoji: { type: "string" }, role: { type: "string" },
    persona: { type: "string" }, system_prompt: { type: "string" },
    tools: { type: "array", items: { type: "string", enum: ["shell", "write_file", "read_file"] } },
    _changed: { type: "string", description: "一句话说明这次改了哪些地方" },
  },
};

// ---------- harness 输出语言指令 ----------
const HARNESS_LANG_DIRECTIVE = "\n\n# 输出语言（最高优先级）\n默认全程用中文：思考过程（thinking）和最终交付内容都必须用中文，禁止默认用英文思考或输出。只有当用户明确要求用其他语言时，才改用用户指定的语言。";

module.exports = {
  DESIGN_SYSTEM, TEAM_SCHEMA,
  PLATFORM_CATALOG, BLUEPRINT_SYSTEM, BLUEPRINT_SCHEMA,
  STAFF_SYSTEM, SKILL_DESIGN_SYSTEM, SKILL_TEAM_SCHEMA,
  EDIT_AGENT_SCHEMA, HARNESS_LANG_DIRECTIVE,
};
