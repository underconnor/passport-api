import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export const privacyNotice = Object.freeze({
  version: '2026-10-01.5',
  purpose: '학교 신원과 소모임 회원 여부를 확인하고 Minecraft 서버 접속 권한을 관리합니다. 검증된 학번을 암호화하여 보관하고 본인의 계정 화면에 표시합니다. 동의한 플레이어의 게임 내 실명·입학 연도 두 자리·회원 여부를 표시하며 서버별 플레이 시간, 블록 채굴·설치, 받은 피해, 사망·몹 처치 수를 기록합니다. 개인 기록은 본인과 관리자에게만 제공하고 전체 통계는 관리자에게 제공합니다. 선택적으로 연결한 Discord 서버에서는 학교 인증·현재 회원·누적 학기 역할과 실명 및 Minecraft 닉네임을 조합한 서버 닉네임을 동기화합니다.',
  items: Object.freeze(['학번(회원 대조용 HMAC 식별 키와 본인 계정 표시용 암호문으로 보관)', '이름, 학과, 학적 상태와 소모임 회원 상태', 'Minecraft UUID와 닉네임, 입학 연도 두 자리(예: 26)', '서버별 접속 상태와 플레이 시간, 채굴·설치 블록 수, 받은 피해, 사망·몹 처치 수', '개인정보 안내 동의 버전과 동의 시각', '선택적으로 연결한 Discord 계정 ID, 사용자 이름과 표시 이름, 서버 ID, 학교·회원·학기 역할 및 동기화 상태', '동의 후 확인된 학기별 소모임 가입 이력(탈퇴 후에도 과거 학기 이력 유지)', 'Discord에 적용할 실명 / Minecraft 닉네임과 봇이 변경 전 복구용으로 보관하는 서버 닉네임', '과거 직접 입력한 Discord ID(검증되지 않은 참고 정보로만 보관)']),
  retention: '폐기 시까지',
  withdrawal: '계정 삭제 또는 동의 철회는 운영진에게 문의바랍니다. 운영진이 요청을 확인하여 처리합니다.',
});
export type ConsentInput = { accepted: boolean; version: string };
export function requireConsent(consent?: ConsentInput) {
  if (!consent?.accepted) throw new BadRequestException({ code: 'consent_required' });
  if (consent.version !== privacyNotice.version) throw new ConflictException({ code: 'consent_version_mismatch' });
  return { version: privacyNotice.version, acceptedAt: new Date() };
}
export function recordConsent(tx: Prisma.TransactionClient, subjectId: string, source: 'portal_login' | 'minecraft_link' | 'discord_link' | 'privacy_renewal', contextId: string, consent: { version: string; acceptedAt: Date }) {
  if (consent.version !== privacyNotice.version) throw new ConflictException({ code: 'consent_version_mismatch' });
  return tx.consentReceipt.create({ data: { subjectId, source, contextId, version: consent.version, acceptedAt: consent.acceptedAt } });
}
