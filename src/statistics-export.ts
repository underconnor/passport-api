import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { zip, strToU8 } from 'fflate';
import type { PassportService } from './passport.service';
import { adminContext, requireAdminTransaction } from './admin';
import { policyTransaction } from './database';
import { verifiedStudentId } from './school-identity';
import { counterNames, counterNumber, emptyCounters, type StatisticsPeriod } from './activity';
import { statisticsSubjectWhere, type StatisticsMembership } from './statistics-membership';

export type StatisticsExportInput = StatisticsPeriod & { membership?: StatisticsMembership; serverId?: string; subjectId?: string };
type Cell = string | number;
const MAX_SUBJECTS = 5000, MAX_ROWS = 50000;
let activeExports = 0;
/** One API process permits at most two workbooks to occupy database/XML/ZIP memory. */
export async function withStatisticsExportSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeExports >= 2) throw new ConflictException({ code: 'statistics_export_busy' });
  activeExports++;
  try { return await operation(); } finally { activeExports--; }
}
const xml = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const column = (index: number): string => { let value = index + 1, result = ''; while (value) { value--; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); } return result; };
function worksheet(rows: Cell[][]) {
  const data = rows.map((row, i) => `<row r="${i + 1}">${row.map((value, j) => typeof value === 'number' ? `<c r="${column(j)}${i + 1}" s="${i === 0 ? 1 : 0}"><v>${value}</v></c>` : `<c r="${column(j)}${i + 1}" s="${i === 0 ? 1 : 0}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${column(Math.max(...rows.map(row => row.length)) - 1)}${rows.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="39" customWidth="1"/><col min="2" max="3" width="18" customWidth="1"/><col min="4" max="4" width="39" customWidth="1"/><col min="5" max="6" width="23" customWidth="1"/><col min="7" max="8" width="25" customWidth="1"/><col min="9" max="16" width="18" customWidth="1"/><col min="17" max="18" width="29" customWidth="1"/></cols><sheetData>${data}</sheetData><autoFilter ref="A1:${column(rows[0]!.length - 1)}${rows.length}"/></worksheet>`;
}
/** Strings are OOXML inline strings, never formulas, including values beginning =,+,-,@. */
export async function statisticsWorkbook(rows: Cell[][], metadata: Cell[][]): Promise<Buffer> {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="사용자별 서버 통계" sheetId="1" r:id="rId1"/><sheet name="내보내기 정보" sheetId="2" r:id="rId2"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
    'xl/styles.xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'),
    'xl/worksheets/sheet1.xml': strToU8(worksheet(rows)),
    'xl/worksheets/sheet2.xml': strToU8(worksheet(metadata)),
  };
  return new Promise((resolve, reject) => zip(files, { level: 6 }, (error, data) => error ? reject(error) : resolve(Buffer.from(data))));
}
export async function exportStatistics(p: PassportService, req: Request, input: StatisticsExportInput) {
  const actor = await adminContext(p, req, true);
  return withStatisticsExportSlot(async () => {
  const data = await policyTransaction(p.db, async tx => {
    await requireAdminTransaction(p, tx, actor);
    const queryNow = new Date(), membership = input.membership ?? 'all';
    const memberWhere = statisticsSubjectWhere(membership, queryNow);
    const servers = await tx.serverRecord.findMany({ where: { statisticsEnabled: true, ...(input.serverId ? { id: input.serverId } : {}) }, orderBy: { id: 'asc' } });
    if (input.serverId && !servers.length) throw new NotFoundException({ code: 'statistics_server_not_available' });
    const subjects = await tx.subject.findMany({ where: { ...memberWhere, ...(input.subjectId ? { id: input.subjectId } : {}) }, include: { minecraft: true }, orderBy: { id: 'asc' }, take: MAX_SUBJECTS + 1 });
    if (input.subjectId && !subjects.length && !await tx.subject.findUnique({ where: { id: input.subjectId }, select: { id: true } })) throw new NotFoundException({ code: 'subject_not_found' });
    if (subjects.length > MAX_SUBJECTS || subjects.length * servers.length > MAX_ROWS) throw new ConflictException({ code: 'statistics_export_too_large' });
    const where = { serverId: { in: servers.map(server => server.id) }, generation: { subjectId: { in: subjects.map(subject => subject.id) } } };
    const source = input.from && input.to
      ? await tx.activityDaily.findMany({ where: { ...where, date: { gte: new Date(input.from), lte: new Date(input.to) } }, include: { generation: { select: { subjectId: true } } }, take: MAX_ROWS + 1 })
      : await tx.activityTotal.findMany({ where, include: { generation: { select: { subjectId: true } } }, take: MAX_ROWS + 1 });
    if (source.length > MAX_ROWS) throw new ConflictException({ code: 'statistics_export_too_large' });
    const grouped = new Map<string, ReturnType<typeof emptyCounters> & { first: string | null; last: string | null }>();
    for (const row of source) {
      const key = `${row.generation.subjectId}/${row.serverId}`, value = grouped.get(key) ?? { ...emptyCounters(), first: null, last: null };
      for (const metric of counterNames) value[metric] = counterNumber(value[metric] + counterNumber(row[metric]));
      const first = row.firstCollectedAt?.toISOString(), last = row.lastCollectedAt?.toISOString();
      if (first && (!value.first || value.first > first)) value.first = first;
      if (last && (!value.last || value.last < last)) value.last = last;
      grouped.set(key, value);
    }
    const rows: Cell[][] = [['Passport 사용자 ID', '전체 학번', '이름', 'Minecraft UUID', 'Minecraft 닉네임', 'Discord ID', '서버 ID', '서버 이름', '접속 시간 (초)', '캔 블록 수', '설치한 블록 수', '받은 피해 (HP)', '죽은 수', '죽인 몹 수', '죽인 플레이어 수', '이동 거리 (m)', '최초 수집 (UTC)', '최근 수집 (UTC)']];
    for (const subject of subjects) for (const server of servers) {
      const value = grouped.get(`${subject.id}/${server.id}`) ?? { ...emptyCounters(), first: null, last: null };
      rows.push([subject.id, verifiedStudentId(subject, p.config.encryptionKey) ?? '', subject.displayName, subject.minecraft?.uuid ?? '', subject.minecraft?.name ?? '', subject.discordId ?? '', server.id, server.label, value.playSeconds, value.blocksBroken, value.blocksPlaced, value.damageTakenMilli / 1000, value.deaths, value.mobKills, value.playerKills, value.distanceCm / 100, value.first ?? '', value.last ?? '']);
    }
    const history = await tx.statisticsHistory.findUnique({ where: { id: 'main' } });
    const metadata: Cell[][] = [['항목', '값'], ['생성 시각 (UTC)', new Date().toISOString()], ['조회 대상', membership === 'active' ? '소모임 회원만' : '전체 사용자'], ['회원 판정 기준', '조회 시점의 현재 회원 상태. 학교 인증 제공자 usaint, membershipStatus active, 회원 유효기간 미만료, 접근 정지 아님. 과거 수집 당시의 신분을 재구성하지 않습니다.'], ['회원 판정 시각 (UTC)', queryNow.toISOString()], ['조회 시작일 (한국)', input.from ?? '누적 전체'], ['조회 종료일 (한국)', input.to ?? '누적 전체'], ['기간별 기록 시작 (UTC)', history?.availableFrom.toISOString() ?? ''], ['일별 기준', '서버가 통계 배치를 수신한 한국 날짜. 지연 전송은 수신일에 합산됩니다.'], ['기존 기록', '기간별 기록 시작 이전 통계는 누적 조회에만 포함됩니다.'], ['학번 공란', '학교 로그인에서 확인하여 저장한 전체 학번이 없는 계정'], ['대상', '수집이 켜진 서버만 포함. 기록이 없는 사용자와 서버는 0으로 표시.']];
    await tx.auditEvent.create({ data: { action: 'admin.statistics_export', actorSubjectId: actor.session.subjectId, details: { rowCount: rows.length - 1, subjectCount: subjects.length, serverCount: servers.length, ...input, membership } } });
    return { rows, metadata };
  });
  return statisticsWorkbook(data.rows, data.metadata);
  });
}
