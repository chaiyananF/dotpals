# ส่งต่อการพัฒนา Dotpals

Repository: https://github.com/chaiyananF/dotpals
เผยแพร่ต้นแบบเมื่อ 2026-10-05 ตามคำสั่งเจ้าของงาน เพื่อให้ทีมพัฒนาต่อ
ฐานเดิมคือ upstream `1b5c67e57f0789c5a533150acd91d3ae63026844` พร้อมส่วนเพิ่ม
session center, task registry, mailbox และ existing-chat coordinator ครบชุด
ยังไม่ได้รวม commit ใหม่บน upstream/main; ประวัติเดิมและ MIT license คงไว้

## โครงสร้างที่ตกลงแล้ว

ผู้ใช้สั่งในแชท Codex/Claude ที่มีอยู่ → ราฟาเอลวิเคราะห์ → ทำเองหรือส่งให้ผู้ช่วย
ผ่าน Dotpals → อ่านผลและหลักฐาน → สรุปกลับในแชทเดิม → รอคำสั่งถัดไป
Dotpals เป็นทะเบียนและ broker ของผู้ช่วย โดยไม่เปิด coordinator CLI เพิ่ม
โมเดลของแชทหลักกับ CLI เป็นคนละช่องทางเข้าถึง ต้องตรวจชื่อที่เรียกได้จริง
ตัวอย่างที่เคยล้มเหลว: standalone Codex CLI ปฏิเสธ `gpt-6.1-sol` ด้วยบัญชี ChatGPT
จึงไม่ควรนำชื่อโมเดลในแอปไปบังคับใช้กับ CLI หรือเปลี่ยนโมเดลเงียบ ๆ

## เปิดเครื่องพัฒนา

ใช้ Node.js/npm และ PowerShell บน Windows:

```powershell
git clone https://github.com/chaiyananF/dotpals.git
cd dotpals
npm install
.\start-center.ps1
```

Launcher หา Electron ใน `node_modules` ของ checkout ก่อน แล้วใช้ installation
เดิมใน home หรือ `DOTPALS_ELECTRON` หากตั้งไว้ โปรไฟล์ส่วนตัวอยู่ใน
`.dotpals-center/` และ bridge ฟังที่ loopback port 5176

เปิดเฉพาะ bridge โดยไม่ใช้หน้าต่าง desktop ได้:

```powershell
$env:DOTPALS_HOME = Join-Path $PWD '.dotpals-center'
$env:DOTPALS_PORT = '5176'
node bridge/server.js
```

เปิด `http://127.0.0.1:5176/dashboard#tasks` ใน browser ของเครื่องนั้น
อย่าใช้พอร์ตนี้เป็น shared server บนเครือข่าย: การระบุผู้ส่งเป็น identity ที่ประกาศ
ในเครื่อง ไม่ใช่ระบบ authentication ของ agent หลายเครื่อง

## ตั้งค่าบริบทของทีมตัวเอง

ข้อมูลทีมและบัญชีของเครื่องต้นทางไม่ได้อยู่ใน repo ให้สร้าง
`.dotpals-center/claude-dispatch.json` สำหรับ context root/model ที่เครื่องตนเรียกได้:

```json
{
  "workingDirectory": "C:/your/team-context",
  "model": "<Claude model supported by your account>",
  "defaultEffort": "medium"
}
```

Context root ควรมี `CLAUDE.md`, `AGENTS.md` และโครงสร้าง role/journal ของทีม
ที่ brief ปัจจุบันอ้างอิง (`MyTeam/roles/<role>.md`, role journals)
ชุดกติกาทีมต้นทางเป็นข้อมูลภายนอก repo นี้ ต้องจัดหาเองหรือปรับ brief ให้เข้ากับทีม
Code checkout/worktree แยกจาก context root ได้; context ถูกใช้อ่านอย่างเดียว
หากต้องการ AGY ให้ติดตั้ง/authenticate CLI แล้วสร้าง cache
`.dotpals-center/dispatch-models.json` รูปแบบ `{ "antigravity": ["<actual-model-id>"] }`
โดยใช้รายการที่ `agy models` ของบัญชีนั้นส่งกลับ
Claude/Codex/AGY executable ใช้ค่า `DOTPALS_CLAUDE`, `DOTPALS_CODEX_CLI`,
`DOTPALS_AGY` ได้ หรือให้ broker หาในตำแหน่งมาตรฐาน/PATH

## จุดสำคัญในโค้ด

| ไฟล์ | หน้าที่ |
| --- | --- |
| `bridge/team-store.js` | JSON store, local lock, task/message/dispatch, external session binding |
| `bridge/team-api.js` | local task/coordinator API และ write request guards |
| `bridge/team-dispatch.js` | worker queue, CLI arguments, run artifacts และผลตอบกลับ |
| `bin/team-center.js` | context / coordinate / delegate / summary และ mailbox CLI |
| `bin/team-mcp.js` | task-bound stdio MCP สำหรับ CLI ที่เปิดโดย broker |
| `bridge/ui/tasks.js`, `tasks.css` | หน้าติดตามงาน ชื่อแชท สรุป และ advanced worker controls |
| `bridge/session-center.js`, `session-links.js` | native session identity, title และประวัติ handoff |
| `bin/claude-session.js`, `antigravity-session.js` | wrapper สำหรับ native resume ที่บันทึกไว้ |
| `desktop/main.js`, `start-center.ps1` | desktop dashboard/prototype profile |

อ่าน [chat-coordinator.md](chat-coordinator.md) สำหรับคำสั่งและ payload จริง
และ [task-mailbox.md](task-mailbox.md) สำหรับ schema/revision/message semantics
`app-dispatch.md` เป็นประวัติโครงสร้าง coordinator CLI ก่อนปรับ ไม่ใช่ workflow หลัก
`docs/work-items/` บันทึกขอบเขตและสถานะของแต่ละ increment

## หลักฐานและงานค้าง

- ตรวจ syntax ของโมดูลที่เปลี่ยน, dashboard inline module และ PowerShell parser แล้ว
- `git diff --check` ผ่าน; ลงทะเบียนแชทจริงและบันทึก summary ผ่าน local API แล้ว
- ยังไม่ได้รัน test suite หรือทดลอง worker dispatch/resume ครบวงจรใน increments ล่าสุด
- test files ของต้นแบบ session-center/session-links เป็นของรอบก่อนและรวมไว้ให้พัฒนาต่อ
  การมีไฟล์ test ไม่ได้หมายความว่าผ่านใน snapshot นี้
- Independent QA และ human acceptance C1–C6 ใน runbook ยังรอทำ
- CLI/model availability, permission prompts, cancellation/process descendants และ
  recovery หลัง bridge หยุด ต้องตรวจด้วย provider ที่เครื่องผู้พัฒนาใช้จริง
- ไม่มี automatic wake-up ของแชท, quota failover หรือ synchronization หลายเครื่อง

รอบถัดไปควรเริ่มจาก runtime acceptance ของหนึ่ง worker แบบอ่านอย่างเดียว แล้ว
ตรวจ native resume และ summary กลับแชทเดิม ก่อนเพิ่ม automation หรือรวม upstream
พัฒนาบน branch ของตนและแบ่ง file ownership; การจ่ายงานไม่ได้ให้อำนาจแก้ทุกไฟล์
การใช้ writePaths/branch และการตรวจรับแยกจาก creator self-check ยังจำเป็น

## ข้อมูลที่ไม่เผยแพร่

`.dotpals-center/`, session logs/native IDs, mailbox ของผู้ใช้, auth files,
run artifacts, model cache และ central team rules/journals ของเครื่องต้นทาง
ไม่ได้รวมใน Git repository ทุกคนต้องใช้ profile/auth ของตนเอง
