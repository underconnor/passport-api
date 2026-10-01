import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export const privacyNotice = Object.freeze({
  version: '2026-10-01.3',
  purpose: '학교 신원과 소모임 회원 여부를 확인하고 Minecraft 서버 접속 권한을 관리합니다. 선택적으로 연결한 Discord 서버에서는 학교 인증·현재 회원·누적 학기 역할과 실명 및 Minecraft 닉네임을 조합한 서버 닉네임을 동기화합니다.',
  items: Object.freeze(['학번(회원 확인에 일시 사용한 뒤 원문 대신 HMAC 식별 키로 보관)', '이름, 학과, 학적 상태와 소모임 회원 상태', 'Minecraft UUID와 닉네임', '개인정보 안내 동의 버전과 동의 시각', '선택적으로 연결한 Discord 계정 ID, 사용자 이름과 표시 이름, 서버 ID, 학교·회원·학기 역할 및 동기화 상태', '동의 후 확인된 학기별 소모임 가입 이력(탈퇴 후에도 과거 학기 이력 유지)', 'Discord에 적용할 실명 / Minecraft 닉네임과 봇이 변경 전 복구용으로 보관하는 서버 닉네임', '과거 직접 입력한 Discord ID(검증되지 않은 참고 정보로만 보관)']),
  retention: '계정 정보와 동의 기록은 계정 삭제 요청이 처리될 때까지 보관합니다. 운영 감사 기록은 90일, 웹 세션은 8시간 보관하며, 연결 요청은 만료 후 24시간이 지나면 정리합니다. 암호화 백업 사본에는 별도의 보관 주기 동안 정보가 남을 수 있습니다.',
  withdrawal: '소모임 운영자에게 계정 삭제 또는 동의 철회를 요청할 수 있습니다. 운영자가 요청을 확인하여 처리하며 이 화면에서 자동 삭제되지는 않습니다.',
});
export type ConsentInput = { accepted: boolean; version: string };
export function requireConsent(consent?: ConsentInput) {
  if (!consent?.accepted) throw new BadRequestException({ code: 'consent_required' });
  if (consent.version !== privacyNotice.version) throw new ConflictException({ code: 'consent_version_mismatch' });
  return { version: privacyNotice.version, acceptedAt: new Date() };
}
export function recordConsent(tx: Prisma.TransactionClient, subjectId: string, source: 'portal_login' | 'minecraft_link' | 'discord_link', contextId: string, consent: { version: string; acceptedAt: Date }) {
  if (consent.version !== privacyNotice.version) throw new ConflictException({ code: 'consent_version_mismatch' });
  return tx.consentReceipt.create({ data: { subjectId, source, contextId, version: consent.version, acceptedAt: consent.acceptedAt } });
}
