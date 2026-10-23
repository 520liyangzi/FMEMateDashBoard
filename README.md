# FMEMate · Project Pulse

本地运行的中英文项目进展报表：导入应用日志 Excel，查看使用趋势、高频问题、用户主动输入、失败明细，以及 Line group 人数增长与客户反馈。中文和英文页面使用同一份数据。

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

## Line group 与客户反馈

- 按日期填写 Line group 总人数。同一天重新填写会更新该日记录，填写的是群总人数，不是新增人数；需要至少两个不同日期的快照才能体现跨日增长。保存真实人数或反馈后自动退出演示模式，筛选日期会自动包含新增记录。
- 人数趋势和增量根据已记录的人数计算；没有填写的日期不会编造数据。增长率基数为 0 时不计算百分比。
- 可以补录历史日期，维护客户评价、来源/作者和反馈截图。截图支持 PNG、JPEG、GIF、WebP，单张最多 10 MB。
- Line group 人数和应用活跃用户是两个独立指标。除非有明确对应关系，不应将两者直接解释为精确的用户转化率。

## 数据保存、备份与重启

服务数据保存在本机：

```text
data/
  report.db       SQLite 数据库：日志、失败原因、预置问题、人数、反馈、导入历史
  uploads/        反馈截图
```

关闭浏览器或重启服务不会清空数据。迁移电脑时，可以在页面下载完整备份 ZIP，再在新服务中恢复。恢复会替换当前正式数据，服务会先保存一份当前数据备份；请核对你选择的备份文件。

“清空日志”仅删除日志、对应失败原因和导入历史，保留预置问题、Line group 人数与反馈。如需找回清空的日志，需重新导入原始 Excel 或恢复备份。

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
| **离线 HTML** | 把导出的单个 `.html` 文件发给领导，双击即可在浏览器打开 | 不需要 Python、本地服务或联网；内含导出时的完整日志快照、人数记录和反馈截图，可切换中英文、筛选日期、查看图表和导出明细；离线报告禁止新增、修改和删除数据 |
| **PDF** | 点击打印，再在浏览器打印窗口选择“另存为 PDF” | 保存当前页面及其当前筛选结果的静态展示；不是整个网站所有页面的自动合集，不包含交互操作 |
| **Excel 工作簿** | 使用 Excel 或兼容软件打开导出的 `.xlsx` | 便于进一步处理结构化指标与明细；不保留网页交互、布局或完整截图展示，展示型汇报建议用离线 HTML 或 PDF |

离线 HTML 的内容固定在导出时刻，后续导入的数据不会自动出现在已发出的文件中；更新后重新导出即可。它包含完整导出快照中的原始问题、回答与截图，文件大小会随日志及截图数量增加。导出时请确认选择了正式数据还是带有“演示数据”标识的示例数据。

## AI 进展汇报

新增 **AI 进展汇报 / AI progress report** Tab。先导入日志、更新群人数和反馈、保存已知失败原因，再进入此页：

1. 展开接口配置，填写 **Base URL、API Key、模型名称**，选择 `Chat Completions` 或 `Responses`，点击“测试连接并保存”。系统先向当前填写的接口、Key 和模型发起一条简短测试请求，收到有效回复后才保存，并显示测试耗时。测试不会发送日志，也不会新增汇报。失败会显示原因，保留原来的配置和 Key；修改后可以重试，原配置未改也可重新测试。OpenAI 的 Base URL 是 `https://api.openai.com/v1`；兼容接口填写服务商的 API 基础地址，不要再拼接 `/chat/completions` 或 `/responses`。模型名称按服务商提供的可用名称填写。
2. 使用页面日期和场景筛选，或者点击“最新日志日”生成最近一天的日报。多日范围会生成明确标注起止日期的阶段汇报。
3. 可补充汇报风格要求，并预览实际提示词与发送的数据摘要。点击“一键生成中英文”，服务会一次生成中文和英文两版自然语言汇报，按使用情况、客户需求、失败排查、群运营和下一步组织内容。
4. 两版汇报均可复制、下载文字或 Markdown，也可通过浏览器打印保存 PDF。生成结果自动保存，历史记录可再次查看；离线 HTML 包含最近 20 份已保存汇报，支持只读查看和复制。

AI 使用与页面相同的统计结果。发送内容是当前筛选范围的完整汇总指标，以及有数量和长度上限的用户排行、问题、失败上下文、已填原因、群人数和文字反馈；示例的上限与覆盖情况会在摘要中标注。不会把整张 Excel 或反馈截图发给模型。群运营数据按日期筛选，不跟随日志 Scene 筛选。示例数据始终标为演示，不能作为正式项目进展。

提示词明确要求：`browser` 的实际人数未知，不得把可识别账号数写成真实总人数；MML 不算自主提问，空回答正常；没有 `Sorry` 不代表业务成功；没有已填写原因的失败应写为待排查；没有可比人数记录时不编造增长；不能从尚未读取的截图推断点赞或好评。AI 输出是草稿，可核对、编辑后发群，网页不会自动发送消息。

API Key 只保存在本地服务的数据目录 `ai-config.json` 中，不回显，不写入浏览器存储、数据库备份、离线报表或 Git 仓库。留空保存会保留已有 Key，勾选清除后保存可移除 Key；清除操作不进行连接测试，即使服务商暂时不可用也能清除。完整数据备份含 AI 汇报历史，不含接口配置；迁移后需要重新配置接口。自定义 `--data-dir` 时配置跟随该目录。模型请求由 Python 后端发起，客户端不用直接连接模型接口；如使用代理，按 Python 标准 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量配置。API 调用是否可用及费用以你配置的服务商为准。

部署前已用本地模拟接口验证生成和异常处理；项目不附带真实 API Key，未执行付费模型请求。输出上限和超时可在界面调整；如果接口提示输出被截断，可以提高上限后重试。已有旧数据库与旧版备份会自动兼容升级。

AI progress report creates both Chinese and English narrative updates from the selected date range and scene. Configure your provider Base URL, API key, model, and Chat Completions or Responses format, then click **Test & save**. A short request checks the current endpoint, key and model before saving; no log data is sent and no report is created. Successful tests show latency. Failed tests preserve the prior configuration and key. An unchanged connection can also be retested. Clearing a key saves without calling the provider, so it works even if the provider is down. After a successful test, generate your report. You can preview the prompt, add style instructions, copy each language, download text/Markdown, and reopen saved reports. The server sends aggregate metrics and bounded textual evidence, including saved failure causes; screenshots and the complete workbook are not sent. Community metrics use the date range independently of the log scene filter. Reports preserve the browser/MML/failure methodology and label missing evidence and demo data. Keys stay in the local server's `ai-config.json`, excluded from backups, offline exports, browser storage and Git. Offline HTML includes the latest 20 saved reports for read-only viewing. No messages are sent automatically. Test coverage uses a local mock provider; configure your own credentials for live generation.

API formats follow the official [Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) and [Responses guide](https://developers.openai.com/api/docs/guides/migrate-to-responses).

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

This is a local bilingual dashboard for FMEMate application usage and Line group progress. Chinese and English views share one persisted dataset.

1. Install Python **3.10+** and extract the entire package.
2. Run `start.bat` on Windows, `bash start.sh` on macOS / Linux, or `python server.py`.
3. Open **http://127.0.0.1:8000**. Keep the terminal open; use `Ctrl+C` to stop.
4. Import Excel logs, configure preset questions, enter daily Line group membership, and add customer feedback with screenshots.

The package includes a prebuilt `dist/` directory. Node.js and pip packages are not required to run it. To rebuild edited frontend source, use Node.js 22.13+, run `npm install`, then `npm run build`.

Expected columns are **Task Id, Client Id, Question, Time, Answer, Scene**. Time may be an Excel date cell or a string such as `9/22/2026 16:57`; wall-clock values are preserved without timezone conversion. Task Id is globally unique: repeated imports keep the first record and count later occurrences as duplicates, including conflicting records.

The invalid Client ID `browser` (case-insensitive, surrounding whitespace ignored) is excluded from all people counts and user rankings. Its records remain in interaction, question and failure totals and raw exports; only non-MML unmatched records count as custom questions. Uses per user is based only on identifiable-user interactions. Existing records are recalculated automatically without reimporting.

Preset matching ignores case, whitespace, punctuation and symbols. MML scenes are always excluded from custom-question counts and details (case and surrounding spaces are ignored), while their usage, active users, question frequency and failures remain counted. In other scenes, questions outside the configured presets are classified as custom questions by rule; this does not prove keyboard input. Failures are answers containing `Sorry`, case-insensitively. An empty answer in the MML scene is valid. Each failure row has a saved cause field that persists after refresh/restart and duplicate imports. Clear and save to remove a cause. Excel and offline HTML exports include saved causes. Full failure details can be exported for analysis. Demo data is clearly labelled and never mixed with persisted imports.

Data lives in `data/report.db` and `data/uploads/`. Use the dashboard ZIP backup and restore controls to move data between computers. Restoring replaces the current dataset and automatically backs up the existing dataset first. Clearing logs removes logs, their saved failure causes, and import history.

For leaders who cannot access your local service, export a **single offline HTML report** and send that file. Double-clicking it opens the report without Python, a server, or Internet access. It includes the export-time snapshot of all imported source logs, membership records, and feedback screenshots; language switching, filters, charts and detail exports remain available, while editing is disabled. Existing offline files do not update automatically—export again after updating the dataset. The file grows with the amount of log and image data.

Use the browser's print dialog to save the **current page** as a static PDF; this does not automatically combine every dashboard tab. The **XLSX export** is for structured indicators and records, and does not reproduce the website's interactive layout or screenshot gallery.

For a different port, run `python server.py --port 8080`. For trusted LAN access, use `python server.py --host 0.0.0.0`; other devices can visit `http://<your-lan-ip>:8000`. The local service has no account authentication, so do not expose it directly to the public Internet.

## 示例与导出说明

`examples/` 中的 Sample 文件有 20 条模拟日志；接着导入 Overlap 文件，会再新增 10 条并跳过 10 条重复，最终共 30 条。Blank Template 只有六列表头。`Offline_Demo.html` 是可直接打开的离线演示报表，所有数据均为模拟。

Excel 单元格有文本长度上限。超过上限的完整 Answer 等文本会拆到 `Answer (cont. 2)` 等续列中，不会截断；按列顺序连接即可还原。离线 HTML 保留完整原始文本与截图。浏览器打印 / 保存 PDF 针对当前页面，表格分页仅打印当前页；完整明细请导出 Excel 或离线 HTML。

开发时可使用 `npm run dev`，它自动启动本地 Python API，并提供前端热更新；默认 API 端口 8000，数据保存在同一个 `data/` 目录。日常展示只运行 `start.bat` 或 `python server.py` 即可。

## 更新到当前版本

保留原目录的 `data/`，覆盖程序文件和完整 `dist/` 后重启服务即可，无需重新导入日志。旧的离线 HTML 是固定快照，更新统计口径后需要重新导出。当前版本：1.2.1。

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
