import { ConflictException } from '@nestjs/common';
import type { ManualSettings } from '@prisma/client';
import type { Request } from 'express';
import { z } from 'zod';
import { adminContext, requireAdminTransaction } from './admin';
import { policyTransaction } from './database';
import type { PassportService } from './passport.service';

const notionSiteHost = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)?notion\.site$/;
const notionWorkspaceHost = /^(?:www\.)?notion\.so$/;
const pageId = /(?:^|[-/])([a-f\d]{32})\/?$/i;

/** Validate only; the API never fetches a registered URL or follows redirects. */
export function normalizeNotionUrl(raw: string, embed = false): string | null {
  if (raw.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const site = notionSiteHost.test(url.hostname);
  if (!site && !notionWorkspaceHost.test(url.hostname)) return null;
  if (embed) {
    if (!site || !/^\/ebd\/[a-f\d]{32}\/?$/i.test(url.pathname)) return null;
  } else if (site) {
    // Published home pages and custom slugs are supported alongside page IDs.
    let path: string;
    try { path = decodeURIComponent(url.pathname); } catch { return null; }
    if (!/^\/(?:[\p{L}\p{N}][\p{L}\p{M}\p{N}_-]{0,255})?\/?$/u.test(path)) return null;
  } else if (!pageId.test(url.pathname)) return null;
  // View IDs are useful for published databases. Tracking and other query input
  // is unnecessary for a manual and must not be copied into the public response.
  const view = url.searchParams.get('v');
  url.search = '';
  if (view && /^[a-f\d]{32}$/i.test(view)) url.searchParams.set('v', view);
  url.hash = '';
  return url.toString();
}

const title = z.string().trim().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const notionUrl = z.string().trim().max(2048).refine(value => normalizeNotionUrl(value) !== null).transform(value => normalizeNotionUrl(value)!);
const embedUrl = z.string().trim().max(2048).refine(value => normalizeNotionUrl(value, true) !== null).transform(value => normalizeNotionUrl(value, true)!);
export const manualSettingsSchema = z.object({ title, notionUrl: notionUrl.nullable(), embedUrl: embedUrl.nullable().optional().default(null), expectedRevision: z.number().int().min(0).max(2147483646) }).strict().superRefine((input, context) => {
  if (!input.embedUrl) return;
  if (!input.notionUrl) { context.addIssue({ code: 'custom', path: ['embedUrl'], message: 'notion_url_required' }); return; }
  const safeSource = normalizeNotionUrl(input.notionUrl), safeEmbed = normalizeNotionUrl(input.embedUrl, true);
  if (!safeSource || !safeEmbed) return; // Field refinements already report these invalid URLs.
  const source = new URL(safeSource), embed = new URL(safeEmbed);
  const sourceId = source.pathname.match(pageId)?.[1]?.toLowerCase();
  const embedId = embed.pathname.match(pageId)?.[1]?.toLowerCase();
  if (!notionSiteHost.test(source.hostname) || source.hostname !== embed.hostname || (sourceId && sourceId !== embedId)) context.addIssue({ code: 'custom', path: ['embedUrl'], message: 'same_notion_page_required' });
});
export type ManualInput = z.infer<typeof manualSettingsSchema>;

function dto(row: ManualSettings | null) {
  return { title: row?.title ?? '매뉴얼', notionUrl: row?.notionUrl ?? null, embedUrl: row?.embedUrl ?? null, configured: Boolean(row?.notionUrl), updatedAt: row?.updatedAt.toISOString() ?? null };
}

export async function getManual(p: PassportService) {
  return dto(await p.db.manualSettings.findUnique({ where: { id: 'main' } }));
}

export async function adminManual(p: PassportService, req: Request) {
  await adminContext(p, req);
  const row = await p.db.manualSettings.findUnique({ where: { id: 'main' } });
  return { ...dto(row), revision: row?.revision ?? 0 };
}

export async function updateManual(p: PassportService, req: Request, input: ManualInput) {
  const actor = await adminContext(p, req, true);
  return policyTransaction(p.db, async tx => {
    await requireAdminTransaction(p, tx, actor);
    const previous = await tx.manualSettings.findUnique({ where: { id: 'main' } });
    if ((previous?.revision ?? 0) !== input.expectedRevision) throw new ConflictException({ code: 'manual_settings_changed' });
    const data = { title: input.title, notionUrl: input.notionUrl, embedUrl: input.embedUrl };
    const updated = previous
      ? await tx.manualSettings.update({ where: { id: 'main' }, data: { ...data, revision: { increment: 1 } } })
      : await tx.manualSettings.create({ data: { id: 'main', ...data } });
    await tx.auditEvent.create({ data: { action: 'admin.manual_updated', actorSubjectId: actor.session.subjectId, objectId: 'main', details: { revision: updated.revision, configured: Boolean(updated.notionUrl), embedded: Boolean(updated.embedUrl) } } });
    return { ...dto(updated), revision: updated.revision };
  });
}
