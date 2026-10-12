import { runTiming } from '../../src/run-progress.js';
const duration = (ms) => { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
const labels = { launch: 'เริ่มเรียกผู้ช่วย', 'session-start': 'เริ่ม session แล้ว', 'tool-start': 'ผู้ช่วยใช้เครื่องมือ', 'tool-finished': 'ได้รับผลจากเครื่องมือ', message: 'ผู้ช่วยส่งข้อความ', thinking: 'ผู้ช่วยกำลังประมวลผล', 'provider-finished': 'ได้รับข้อมูลสรุปจากผู้ช่วย', output: 'ได้รับข้อมูลจากผู้ช่วย', stderr: 'ได้รับข้อมูลวินิจฉัยจากผู้ช่วย' };
export function runProgressText(job, now = Date.now()) {
  if (job.status === 'queued') return 'รอเริ่มทำงาน — ยังไม่นับเวลา timeout';
  const timing = runTiming(job, now);
  const clock = timing.elapsedMs === null ? 'ไม่ทราบเวลาเริ่ม' : `ใช้เวลา ${duration(timing.elapsedMs)}`;
  const remaining = timing.remainingMs === null ? '' : ` · เหลือก่อน timeout ${duration(timing.remainingMs)}`;
  if (job.progress?.available === false) return `${clock}${remaining} — ข้อมูลกิจกรรมใช้ไม่ได้ ไม่ยืนยันว่า worker ค้าง`;
  const last = labels[job.progress?.lastActivityKind];
  const activity = last && timing.quietForMs !== null ? `${last} · ${duration(timing.quietForMs)} ที่แล้ว` : 'ยังไม่มีข้อมูลกิจกรรมล่าสุด';
  const quiet = job.status === 'running' && (timing.quietForMs === null || timing.quietForMs >= 60_000) ? ' · ยังไม่ได้รับกิจกรรมใหม่ ไม่ยืนยันว่าค้าง' : '';
  return `${clock}${remaining} — ${activity}${quiet}`;
}
