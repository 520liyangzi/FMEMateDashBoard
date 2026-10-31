# FMEMate · Project Pulse

本地运行的中英文项目进展报表：导入应用日志 Excel，查看使用趋势、高频问题、用户主动输入、失败明细，以及 Line group 人数增长与客户反馈；生成 AI 总结提示词，并按日期归档已核对的中英文汇报。中文和英文页面使用同一份数据。

## 快速启动

1. 解压完整目录，保留 `dist/`、`server.py`、`ai_service.py` 和启动脚本的相对位置。
2. 安装 **Python 3.10 或更高版本**。运行服务不需要 Node.js，也不需要安装 pip 依赖。
3. Windows 双击 `start.bat`；macOS / Linux 在目录中执行 `bash start.sh`。也可以执行：

   ```bash
   python server.py
   # macOS / Linux 通常使用：
   python3 server.py
   ```

4. 在浏览器打开 **http://127.0.0.1:8000**。服务运行期间保留终端窗口；按 `Ctrl+C` 退出。

如果 8000 端口被占用：

```bash
python server.py --port 8080
```

然后打开 http://127.0.0.1:8080 。可以使用 `--data-dir` 指定持久化数据目录：

```bash
python server.py --data-dir D:\FMEMateData
```

初次打开时可以浏览明确标注的演示数据。演示数据不写入数据库，也不会混入正式导入结果。导入你的 Excel 后查看正式统计。

## Excel 格式与导入

支持 `.xlsx`、`.xls` 和 `.csv`。建议使用以下列标题；每行为一次调用日志：

| 列 | 内容 | 示例 |
| --- | --- | --- |
| Task Id | 单次调用唯一标识 | task-0001 |
| Client Id | 用户标识，用于去重统计人数 | client-001 |
| Question | 用户问题 | Help me analyze this ticket |
| Time | 日志时间 | 9/22/2026 16:57 |
| Answer | 返回内容，可为空 | Diagnosis completed |
| Scene | 场景 | MML |

- `Task Id`、`Client Id`、`Question` 和有效时间是必要信息。异常行会列出原因，便于修正后再次导入。
- Excel 时间单元格和 `9/22/2026 16:57` 这样的月/日/年格式均可识别。日志时间按表中原始时刻统计，不进行时区换算。
- 多个工作表中的有效数据均可导入。建议统一列标题，避免混入标题说明或汇总行。
- 可以频繁重复上传同一文件或包含交叉日期的文件。服务以 **Task Id 全局去重，保留第一次导入的记录**；同一 Task Id 的后续记录即使内容不同，也记为重复，不会覆盖历史数据。
- 每次导入显示新增、重复、异常行数量，并保留导入历史。建议把长数字形式的 ID 在 Excel 中设置为文本，避免 Excel 自身丢失精度。

## 统计口径

- **使用次数**：去重后的日志条数；不是会话数。
- **使用人数**：当前筛选范围内不同 `Client Id` 的数量，排除异常 ID `browser`（忽略大小写和首尾空格）。单日趋势、提问人数、自主提问人数、新增/回访人数和历史周期人数均采用相同规则；Top 使用者与用户排行榜也不展示该 ID。
- **browser 日志**：因历史问题将多个用户的 ID 统一记为 `browser`，无法还原真实人数。这些日志完整保留，继续参与使用次数、问题次数、失败次数与失败率统计；其中非 MML 且未匹配预置问题的日志仍计入自主提问次数，原始明细和 Excel 导出的 `browser 日志明细` 中也可查看；人均使用次数只使用其他可识别用户的日志计算。历史数据无需重新导入，更新程序后自动按新规则重算。
- **高频问题**：规范化问题后合并统计，展示排序和使用次数。排名表示文本匹配，不做语义推断。
- **系统预置问题 / 主动输入**：在设置中维护预置问题，一行一个。匹配忽略大小写、空白、Unicode 标点和符号，例如 `Which cell is faulty?` 与 `which cell is faulty` 会匹配同一预置问题。**Scene 为 MML 的记录一律不算自主提问**（场景比较忽略大小写和首尾空格）；其余场景中，不在预置列表内的归为自主提问。MML 仍计入使用次数、活跃用户、高频问题和失败统计；同一问题横跨多个场景时，高频问题分类会显示混合类型，并在 Excel 中分列导出 MML / 预置 / 自主提问次数。自主提问次数、人数、用户排行中的自主提问次数、每日自主提问及导出明细均采用该口径。修改预置列表后，历史记录会按新规则重新计算。
- **失败**：`Answer` 包含 `Sorry` 即计为失败，忽略大小写。失败明细保留 Task Id、Client Id、Question、Time、Answer 和 Scene，可供导出分析。每条失败记录可填写原因并点击保存，刷新/重启后保留，重复导入不会覆盖原因；Excel 和离线 HTML 也会带上已保存原因。清空输入后再次保存可移除原因。这个指标是约定的文本识别规则，并不等同于真实业务故障率。
- **MML 空返回**：`Scene` 为 `MML` 且 `Answer` 为空属于正常情况；不会仅因空白计为失败。其他空返回也不会自动计为失败，失败规则仍为是否包含 `Sorry`。
- **新增 / 回访用户**：根据已导入历史中的首次出现日期判断；没有导入的早期日志不参与判断。周期比较仅反映现有日志覆盖范围。
- 日期筛选同时影响报表中的日志趋势、排名和失败明细。Excel 和 PDF 按页面当前筛选结果生成；离线 HTML 包含完整数据快照并保留当前筛选条件。

## 用户次日留存与周期复用 / Retention and repeat usage

**概览 / Overview** 展示所选结束日期的次日留存摘要，并在活跃度面板提供周期复用率；**用户分析 / User analytics** 提供次日留存与周期复用率面板、最近 14 天的每日留存明细，以及每页 10 位用户的使用频率表。两项指标用途不同：次日留存回答“昨天用过的人，今天回来多少”，周期复用率回答“这个区间有多少人跨天再次使用”。

| 指标 | 计算口径 | 示例 |
| --- | --- | --- |
| **次日留存（D1）** | 日期 D−1 和 D 都活跃的可识别 ID 数 ÷ D−1 的可识别活跃 ID 数 | 昨天 9 个 ID 活跃，其中 9 个今天也活跃：**9 / 9 = 100%** |
| **周期复用率** | 所选区间中至少在 **N 个不同日期** 活跃的可识别 ID 数 ÷ 区间全部可识别活跃 ID 数；N 默认 3，可调整 | N = 3 时，区间 10 个 ID 活跃，其中 6 个至少在 3 天使用：**6 / 10 = 60%** |
| **活跃天数占比** | 观察到的活跃日期数 ÷ 所选区间的自然日数 | 同一天调用多次仍只算 1 个活跃日 |
| **最长连续活跃天数** | 在相邻自然日上连续观察到活跃的最长天数 | 10 月 21 日与 23 日活跃属于 2 个活跃日，不是连续 2 天 |

D1 的基准是前一天的**全部可识别活跃 ID**，不是只统计前一天首次注册或首次出现的新用户。次日留存摘要卡片固定以所选范围的结束日期 D 为准，**不是整个区间的平均留存**；D−1 可以位于所选开始日期之前，系统会从已导入历史中查找。两个日期均采用同一个 Scene 筛选；MML 的有效活动也参与，包括正常的空 Answer。所有留存与复用指标均排除空白 Client Id 和异常 `browser`（忽略该异常 ID 的大小写与首尾空格），重复 Task Id 只保留首次导入记录。

只有两个日期都存在已导入日志时，才能展示该对日期的 D1。日期覆盖按**任意 Scene 的日志**判断，再按当前 Scene 计算用户集合；任一日期完全没有日志时显示“数据不足 / 不可用”，不是补成 0%。D−1 没有可识别基准用户时也不计算百分比。周期复用门槛可在项目概览或用户分析中设置为 2–3660 个不同日期，默认 3，日期不要求连续。网页会记住当前浏览器的设置；离线 HTML 保留导出时的门槛，Excel、打印说明和 AI 总结也采用同一口径。所选自然日数或区间内有日志的日期数不足 N，或没有可识别活跃用户时，周期复用率显示不可用，不把缺少观察窗口写成 0%。

使用时先导入需要比较的两个日期，再选择结束日期；例如选择 10 月 23 日，会比较 10 月 22 日与 23 日。查看周期复用率时选择多日范围，并保留完整的相关日志。每日留存明细最多展开所选区间末尾 **3,660 个自然日**；页面显示最近 14 天，AI 总结附带最多 31 天的留存证据。Excel 新增每日留存与逐用户使用频率工作表；逐用户导出包含全量记录，不受页面每页 10 行限制。离线 HTML 根据完整日志快照推导相同指标，更新版本无需数据库迁移或重新导入已有日志。

这些都是**已导入数据中观察到的可识别 ID 指标**，不是实际全部用户的真实留存率。ID 需要跨日期稳定才能匹配；`browser` 背后的人数无法还原。当天尚未结束或日志未导全时结果可能变化；没有日志的日期无法区分未使用与未导入。后加入的用户拥有更短的复用观察时间，不能仅凭周期复用率或活跃天数占比判断使用习惯或项目成败。

**Overview** shows next-day retention for the selected end date D and period repeat usage in its engagement panel. **User analytics** provides D1 and period repeat-usage panels, the latest 14 daily retention rows, and a user-frequency table with 10 users per page.

- **Next-day retention (D1)** = identifiable IDs active on both D−1 and D / identifiable IDs active on D−1. If all 9 of yesterday's active IDs return today, **9 / 9 = 100%**. The cohort includes every identifiable ID active yesterday, not just new sign-ups or newly observed users. The summary card describes the selected end date, not a range average; its prior-day baseline can fall before the selected start date.
- **Period repeat-usage rate** = identifiable IDs active on at least **N distinct dates** / all identifiable IDs active in the selected period. N defaults to **3** and can be set to 2–3660 in Overview or User analytics. With N = 3, 6 accounts active on at least three dates out of 10 active accounts means **6 / 10 = 60%**. Dates need not be consecutive, and repeated calls on one date count as one active day. The browser remembers the setting; offline HTML retains the exported threshold. Excel, print explanations and AI summary use the same threshold.
- **Active-day share** = observed active dates / selected calendar days. **Longest streak** counts only adjacent calendar dates with observed activity; activity on the 21st and 23rd is not a two-day streak.

The same Scene filter applies to both D1 days. MML activity, including a normal empty answer, counts. Blank Client IDs and the invalid `browser` ID are excluded; the browser comparison ignores case and surrounding whitespace. Task IDs remain deduplicated. Day coverage is checked using imported logs from any Scene before applying the selected Scene to user sets. If either day has no imported logs, D1 is unknown rather than 0%; a zero identifiable-user baseline is also unavailable. Period repeat usage is unavailable when the selected calendar-day count or globally observed log-date count is below N, or there are no identifiable users. These unavailable cases are not reported as 0%.

Import both comparison days, then select the end date. For example, an end date of October 23 compares October 22 with October 23. Daily retention expansion is limited to the last 3,660 selected calendar days; the screen shows 14 rows and AI summary evidence includes at most 31. Excel includes daily retention and complete per-user frequency sheets, unaffected by the 10-row on-screen pagination. Offline HTML derives the same metrics from its complete log snapshot. No database migration or reimport is needed for existing records.

These are observed metrics for identifiable IDs in imported logs, not verified retention of all actual people. IDs must remain stable across dates. An unfinished day or incomplete imports can change the results; a day without logs cannot distinguish inactivity from missing data. Late joiners have less time to return, so period repeat usage and active-day share should be interpreted with that observation window in mind.

## Line group 与客户反馈

- 按日期填写 Line group 总人数。同一天重新填写会更新该日记录，填写的是群总人数，不是新增人数；需要至少两个不同日期的快照才能体现跨日增长。保存真实人数或反馈后自动退出演示模式，筛选日期会自动包含新增记录。
- 人数趋势和增量根据已记录的人数计算；没有填写的日期不会编造数据。增长率基数为 0 时不计算百分比。
- 可以补录历史日期，维护客户评价、来源/作者和反馈截图。截图支持 PNG、JPEG、GIF、WebP，单张最多 10 MB。
- Line group 人数和应用活跃用户是两个独立指标。除非有明确对应关系，不应将两者直接解释为精确的用户转化率。

## 数据保存、备份与重启

服务数据保存在本机：

```text
data/
  report.db       SQLite 数据库：日志、失败原因、预置问题、人数、反馈、导入历史、每日总结与已保存汇报
  uploads/        反馈截图
```

关闭浏览器或重启服务不会清空数据。迁移电脑时，可以在页面下载完整备份 ZIP，再在新服务中恢复。恢复会替换当前正式数据，服务会先保存一份当前数据备份；请核对你选择的备份文件。

“清空日志”仅删除日志、对应失败原因和导入历史，保留预置问题、Line group 人数、反馈、每日总结与已保存汇报。如需找回清空的日志，需重新导入原始 Excel 或恢复备份。

不要在服务运行时直接修改或删除数据库文件。建议定期通过页面备份，并保留原始 Excel。

## 给客户演示

同一台电脑展示时，直接打开本机地址即可。若需要同一局域网的其他电脑访问：

```bash
python server.py --host 0.0.0.0 --port 8000
```

在其他电脑访问 `http://你的局域网IP:8000`，并按需放行系统防火墙。服务默认没有账号登录，局域网中能够访问地址的人也能操作数据；仅在可信网络中使用，不要直接开放到公网。

## 导出给无法访问本机服务的领导

页面可以导出三种报告，适合不同的查看方式：

| 格式 | 查看方式 | 内容与限制 |
| --- | --- | --- |
| **离线 HTML** | 把导出的单个 `.html` 文件发给领导，双击即可在浏览器打开 | 不需要 Python、本地服务或联网；内含导出时的完整日志快照、人数记录、反馈截图和全部每日总结归档，可切换中英文、筛选日期、查看图表和导出明细；离线报告禁止新增、修改和删除数据 |
| **PDF** | 点击打印，再在浏览器打印窗口选择“另存为 PDF” | 保存当前页面及其当前筛选结果的静态展示；不是整个网站所有页面的自动合集，不包含交互操作 |
| **Excel 工作簿** | 使用 Excel 或兼容软件打开导出的 `.xlsx` | 便于进一步处理结构化指标与明细；不保留网页交互、布局或完整截图展示，展示型汇报建议用离线 HTML 或 PDF |

离线 HTML 的内容固定在导出时刻，后续导入的数据不会自动出现在已发出的文件中；更新后重新导出即可。它包含完整导出快照中的原始问题、回答与截图，文件大小会随日志及截图数量增加。导出时请确认选择了正式数据还是带有“演示数据”标识的示例数据。

## AI总结 / AI summary

左侧 **工作空间 / Workspace** 中的 **AI总结 / AI summary** 用来准备本地 AI 工具所需的完整提示词，无需在网页配置 API 地址、模型或 Key：

1. 导入日志，更新 Line group 人数与反馈，保存已知失败原因。
2. 在工作空间打开“AI总结”，选择日期和 Scene；点击“仅看最近有日志的一天”可生成日报范围。多日范围会要求输出阶段汇报。
3. 可补充汇报风格要求，点击“生成 AI 总结提示词”。提示词包含当前统计汇总、问题排行、自主提问、次日留存与周期复用、有限的失败上下文与已填原因、群人数及文字反馈。截图不会放入提示词；示例上限和截断情况会保留。
4. 复制完整提示词交给本地 AI 工具，或者下载 `FMEMate_AI_Report_Prompt_起始日期_结束日期.md` 并放到项目根目录。在该目录打开本地 AI 工具，粘贴页面提供的“请读取 …，按要求生成中英文汇报”指令。
5. 提示词要求生成 `reports/FMEMate_Progress_起始日期_结束日期_zh.md` 和对应 `_en.md`，按使用情况、客户需求、失败排查、群运营、下一步组织自然语言汇报。核对后可复制到群里，也可存入“每日总结”归档。

生成提示词的过程完全在浏览器本地完成，不调用模型接口、不读取 Key、不自动启动本地 AI 工具，也不自动发消息。离线 HTML 也可以根据其数据快照生成提示词。修改筛选范围或补充要求后请重新生成；已下载的文件是当时的固定快照。

提示词沿用页面口径：`browser` 的实际人数未知；MML 不计自主提问且空返回正常；没有 `Sorry` 不代表业务成功；未保存原因的失败应写为待排查；没有可比群人数时不编造增长；不能从截图存在标识推断好评。模型只使用附带的事实数据，不重算数据库、不修改源码或 Git、不读取密钥配置、不额外调用接口。模型输出仍需人工核对。

下载的提示词和生成的 `reports/` 可能包含日志证据，已加入 `.gitignore`。上一版已经保存的汇报保留，可在历史草稿中查看、复制和下载；完整备份及离线 HTML 继续包含已保存汇报。旧的本地 API 配置文件不会被删除，新流程无需使用它。

The **AI summary** tab is under **Workspace**. It creates a self-contained prompt locally from the current dates, scene and calculated metrics. No API URL or key is needed in the dashboard. Copy the prompt into your local AI tool, or download `FMEMate_AI_Report_Prompt_FROM_TO.md` into the project root, open the tool there and use the displayed read-file instruction. The prompt requests separate Chinese and English Markdown reports in `reports/`, with dated headings and concise paragraphs for usage, needs, failure investigation, community progress and suggested next actions. It includes bounded textual evidence, next-day retention and period repeat-usage metrics, and reporting rules; screenshots are excluded. Offline snapshots support the same local prompt flow. Regenerate after changing filters or writing preferences. Review the output before sharing or saving it in **Daily summaries**. Existing saved report drafts remain available. Downloaded prompt files and generated reports are ignored by Git.

## 每日总结 / Daily summaries

左侧 **项目成效 / Project intelligence** 中的 **每日总结 / Daily summaries** 保存已核对的中英文汇报，作为按日期归档的项目进展记录，与日志筛选范围分开管理。

1. 打开“每日总结”。已有记录时默认显示最新日期的总结；可以选择其他归档日期查看，或选择新日期创建记录。
2. 填写总结日期和可选标题，将中文、英文汇报分别粘贴到对应输入框；也可分别导入本地 `.md` 文件。导入只填入草稿，检查内容后再点击保存。至少填写一种语言即可保存。
3. **每个日期保留一份总结**。再次保存同一天会更新该日期的内容，适合补充当天进展；其他日期的历史记录继续保留。关闭浏览器、刷新页面或重启服务后，已保存内容仍在。
4. 需要回顾进展时，从日期归档中打开对应记录，查看或复制已保存正文。新生成的 AI 文本不会自动覆盖归档，需由你核对后保存。

每日总结保存在本地数据库中，完整备份 ZIP 会包含全部日期的归档；恢复备份时随正式数据一同恢复。“清空日志”保留每日总结。导出离线 HTML 时会包含**全部已保存的每日总结**，不只包含当前打开的日期；接收者可查看归档，离线模式不允许新增、修改、导入或删除总结。已发出的离线文件不会自动更新，需要重新导出。

Open **Project intelligence → Daily summaries** to archive reviewed reports by date. The latest saved date opens by default when records exist. Choose a date and an optional title, then paste the Chinese and English texts into their respective fields or import a `.md` file for either language. Import fills a draft; review it and save explicitly. At least one language is required. There is one record per date: saving the same date updates it while other dates remain available. Saved summaries persist across refreshes and service restarts, and generated AI text does not overwrite them automatically.

Full backups include the complete daily archive, and clearing logs preserves it. An offline HTML export includes all saved daily summaries, with viewing and copying available and editing or importing disabled. Offline files remain fixed snapshots; export again to share later updates.

## 打印与 PDF

点击打印会导出**当前 Tab、当前筛选结果、当前表格页**，不会自动合并其他 Tab 或所有表格页。默认使用 A4 横向；浏览器打印窗口中选择“另存为 PDF”即可。打印版会显示日期、Scene、搜索条件以及表格页码和行范围。完整记录仍请导出 Excel 或离线 HTML。

Overview 与 Line group 使用单独的固定坐标矢量图打印，避免屏幕图表在纸面重新测量后变形。问题排行等表格使用打印列宽、自动换行和重复表头；普通行避免在两页之间拆开，内容较长时会继续分页。Custom / Failure 打印完整 Answer 和已保存失败原因。网页交互控件不会出现在打印结果里。

Print / Save PDF covers the current tab, filters and visible table page. It defaults to A4 landscape and includes static filter and row-range context. Charts use stable vector geometry, tables wrap and repeat headers across pages, and saved failure causes and full answers are retained. Use Excel or offline HTML for the complete dataset.

## 修改前端源码

发布包已包含构建后的 `dist/`，日常启动无需构建。如果修改 React / TypeScript / CSS 源码，需要安装 **Node.js 22.13 或更高版本**，然后在项目目录执行：

```bash
npm install
npm run build
python server.py
```

前端构建只读取本项目依赖，不需要模型 API Key。构建产物写入 `dist/`，由 Python 服务提供页面和 API。

验证命令：

```bash
python backend_tests.py
python ai_backend_tests.py
npm run test
```

## English quick guide

This is a local bilingual dashboard for FMEMate application usage and Line group progress, with local AI summary prompts and a dated archive of reviewed reports. Chinese and English views share one persisted dataset.

1. Install Python **3.10+** and extract the entire package.
2. Run `start.bat` on Windows, `bash start.sh` on macOS / Linux, or `python server.py`.
3. Open **http://127.0.0.1:8000**. Keep the terminal open; use `Ctrl+C` to stop.
4. Import Excel logs, configure preset questions, enter daily Line group membership, and add customer feedback with screenshots.
5. Under **Workspace**, use **AI summary** to prepare a prompt for your local AI tool, then paste or import the reviewed Chinese and English reports into **Project intelligence → Daily summaries** and save them by date.

The package includes a prebuilt `dist/` directory. Node.js and pip packages are not required to run it. To rebuild edited frontend source, use Node.js 22.13+, run `npm install`, then `npm run build`.

Expected columns are **Task Id, Client Id, Question, Time, Answer, Scene**. Time may be an Excel date cell or a string such as `9/22/2026 16:57`; wall-clock values are preserved without timezone conversion. Task Id is globally unique: repeated imports keep the first record and count later occurrences as duplicates, including conflicting records.

The invalid Client ID `browser` (case-insensitive, surrounding whitespace ignored) is excluded from all people counts and user rankings. Its records remain in interaction, question and failure totals and raw exports; only non-MML unmatched records count as custom questions. Uses per user is based only on identifiable-user interactions. Existing records are recalculated automatically without reimporting.

Preset matching ignores case, whitespace, punctuation and symbols. MML scenes are always excluded from custom-question counts and details (case and surrounding spaces are ignored), while their usage, active users, question frequency and failures remain counted. In other scenes, questions outside the configured presets are classified as custom questions by rule; this does not prove keyboard input. Failures are answers containing `Sorry`, case-insensitively. An empty answer in the MML scene is valid. Each failure row has a saved cause field that persists after refresh/restart and duplicate imports. Clear and save to remove a cause. Excel and offline HTML exports include saved causes. Full failure details can be exported for analysis. Demo data is clearly labelled and never mixed with persisted imports.

Data lives in `data/report.db` and `data/uploads/`. Use the dashboard ZIP backup and restore controls to move data between computers. Restoring replaces the current dataset and automatically backs up the existing dataset first. Clearing logs removes logs, their saved failure causes, and import history, while preserving presets, Line group records, feedback, saved report drafts, and the complete daily summary archive.

For leaders who cannot access your local service, export a **single offline HTML report** and send that file. Double-clicking it opens the report without Python, a server, or Internet access. It includes the export-time snapshot of all imported source logs, membership records, feedback screenshots, and the complete daily summary archive; language switching, filters, charts and detail exports remain available, while editing is disabled. Existing offline files do not update automatically—export again after updating the dataset. The file grows with the amount of log and image data.

Use the browser's print dialog to save the **current page** as a static PDF; this does not automatically combine every dashboard tab. The **XLSX export** is for structured indicators and records, and does not reproduce the website's interactive layout or screenshot gallery.

For a different port, run `python server.py --port 8080`. For trusted LAN access, use `python server.py --host 0.0.0.0`; other devices can visit `http://<your-lan-ip>:8000`. The local service has no account authentication, so do not expose it directly to the public Internet.

## 示例与导出说明

`examples/` 中的 Sample 文件有 20 条模拟日志；接着导入 Overlap 文件，会再新增 10 条并跳过 10 条重复，最终共 30 条。Blank Template 只有六列表头。`Offline_Demo.html` 是可直接打开的离线演示报表，所有数据均为模拟。

Excel 单元格有文本长度上限。超过上限的完整 Answer 等文本会拆到 `Answer (cont. 2)` 等续列中，不会截断；按列顺序连接即可还原。离线 HTML 保留完整原始文本与截图。浏览器打印 / 保存 PDF 针对当前页面，表格分页仅打印当前页；完整明细请导出 Excel 或离线 HTML。

开发时可使用 `npm run dev`，它自动启动本地 Python API，并提供前端热更新；默认 API 端口 8000，数据保存在同一个 `data/` 目录。日常展示只运行 `start.bat` 或 `python server.py` 即可。

## 更新到当前版本

保留原目录的 `data/`，覆盖程序文件和完整 `dist/` 后重启服务即可，无需重新导入日志。旧的离线 HTML 是固定快照，更新统计口径后需要重新导出。当前版本：1.6.0。

遇到接口 500 时，启动窗口会显示异常类型、出错文件与行号；`NameError` 还会显示未定义的 Python 变量名。诊断不打印请求内容、源码行、局部变量或原始异常消息。排查时保留这些定位行即可，历史日期的 Line group 人数支持补录和同日更新。

For API 500 errors, the server console shows the exception type and file/line locations; `NameError` also identifies the undefined Python name. Diagnostics omit request content, source lines, local values and raw exception messages. Historical Line group dates support backfilling and same-date updates.

## 从 GitHub 获取

```bash
git clone https://github.com/520liyangzi/FMEMateDashBoard.git
cd FMEMateDashBoard
python server.py
```

仓库包含可直接运行的 `dist/`，克隆后无需安装 Node.js 或 npm 依赖即可启动。个人日志、数据库、截图和备份不纳入 Git 版本管理。

Failure causes are stored by Task Id and included in full backups. Existing databases upgrade automatically; backups from older versions without causes remain supported. Line group entries are date-specific **total member counts**; saving the same date replaces that total. Saving real group data exits demo mode and expands the visible date range to include the new record.

## 用户人数展示口径

概览和用户分析固定展示“人数统计说明”，Top 用户排行旁也说明 `browser` 未计入人数。日志缺陷会把不同用户统一记为 `browser`，无法区分真实人数；因此页面和 Excel 使用“可识别活跃用户”命名，相关使用次数仍计入总量。例如当前只有 `browser` 和 `yangzi` 时，可识别账号数为 1，实际使用总人数无法从这些日志确定，不能理解为只有 1 人使用。中英文页面、离线报表、PDF 打印和 Excel 均采用相同展示口径。

Overview and User analytics always explain the user-count methodology. A logging bug merges multiple users into `browser`; that ID is excluded from people counts and rankings while its interactions stay in usage totals. The displayed **identifiable active users** count is not the actual total number of users. The explanation is also included in Excel and offline reports.


## 上站记录 / Site visits

在「上站记录」中选择上站日期，填写站点或区域（选填）与现场简介，并添加照片。支持同一天多条记录、补录历史日期、编辑与删除；保存后日期筛选会扩展以显示刚保存的记录。支持 JPG、PNG、WebP、GIF，每条最多 10 张、每张不超过 10 MB。手机 HEIC 照片请先转为 JPG。文字简介与照片至少填写一项。界面支持中英文切换，用户输入内容保留原文。

照片点击可查看原图。按当前日期范围统计上站天数、记录数和照片数，Scene 筛选不影响上站记录。Excel 导出日期、站点、简介和照片数；图片请通过离线 HTML 或打印 / 保存 PDF 分享。离线网页包含全部上站记录及嵌入照片，可切换日期查看，不能修改。演示数据导出不携带真实上站记录。

记录与照片保存在本地 data 目录，重启后保留；ZIP 备份与恢复包含上站记录及照片，兼容旧版无上站记录的备份。清空应用日志不会删除上站记录。请使用新版本恢复含上站记录的新备份。

**Site visits** supports a visit date, optional site/area, description and up to 10 photos per entry. Multiple visits on the same day and historical backfills are supported. Edit or delete saved entries; competing edits are detected before overwriting. JPG, PNG, WebP and GIF are accepted, up to 10 MB each; convert HEIC to JPG first. Include a description or at least one photo. User-authored text retains its original language.

Date filters apply to visit counts, visit days and photo totals independently of Scene. Click photos to view them in full. Excel includes visit text and photo counts; use offline HTML or Print / Save PDF to share photos. Offline HTML embeds the complete visit archive and images, remains read-only, and excludes real visits from demo exports. Local persistence and ZIP backups include visits/photos; old backups without visits remain compatible. Clearing application logs preserves site visits.
