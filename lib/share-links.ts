import { validateSceneDocument } from '@/lib/persistence';
import { createId, type SceneDocument } from '@/lib/studio-types';

const SHARE_VERSION = 1;
const MAX_SHARE_PAYLOAD_LENGTH = 1_500_000;

interface ShareEnvelope {
  version: 1;
  createdAt: string;
  document: SceneDocument;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('The shared project payload is malformed.');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function gzip(bytes: Uint8Array) {
  if (typeof CompressionStream === 'undefined') return bytes;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const stream = new Blob([buffer]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array) {
  if (typeof DecompressionStream === 'undefined') return bytes;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeShareDocument(doc: SceneDocument) {
  const validated = validateSceneDocument(doc);
  const sharedDocument: SceneDocument = { ...structuredClone(validated), checkpoints: [] };
  const envelope: ShareEnvelope = { version: SHARE_VERSION, createdAt: new Date().toISOString(), document: sharedDocument };
  const encoded = bytesToBase64Url(await gzip(new TextEncoder().encode(JSON.stringify(envelope))));
  if (encoded.length > MAX_SHARE_PAYLOAD_LENGTH) throw new Error('This project is too large for a browser-only share link. Export the native project file instead.');
  return encoded;
}

export async function decodeShareDocument(payload: string) {
  if (!payload || payload.length > MAX_SHARE_PAYLOAD_LENGTH) throw new Error('The shared project payload is missing or too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await gunzip(base64UrlToBytes(payload))));
  } catch {
    throw new Error('The shared project link is corrupt or unsupported.');
  }
  if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== SHARE_VERSION || !('document' in parsed)) {
    throw new Error('The shared project link uses an unsupported version.');
  }
  return validateSceneDocument(parsed.document);
}

export async function createReadOnlyShareUrl(doc: SceneDocument, location = window.location) {
  const payload = await encodeShareDocument(doc);
  return `${location.origin}${location.pathname}#share=${payload}`;
}

export async function readSharedDocumentFromHash(hash: string) {
  const match = hash.match(/^#share=([A-Za-z0-9_-]+)$/);
  return match ? decodeShareDocument(match[1]) : null;
}

export function makeEditableCopy(doc: SceneDocument, title = `${doc.title} copy`): SceneDocument {
  const now = new Date().toISOString();
  return validateSceneDocument({
    ...structuredClone(doc),
    projectId: createId('project'),
    title: title.trim().slice(0, 100) || `${doc.title} copy`,
    revision: doc.revision + 1,
    updatedAt: now,
    branch: { parentProjectId: doc.projectId },
    checkpoints: [],
    features: [...doc.features, {
      id: createId('feature'), kind: 'version', label: 'Created editable copy from read-only share', objectIds: doc.objects.map((object) => object.id),
      revision: doc.revision + 1, createdAt: now, actor: 'human',
    }],
  });
}
