import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateMedia } from '../src/media/index.js';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2uoAAAAASUVORK5CYII=';

// #8789: `od media generate --image <ref>` rejected references that exist in a
// project whose files live OUTSIDE the daemon's managed projectsRoot (an
// imported project with metadata.baseDir set). The dispatcher resolved
// `ensureProject(projectsRoot, projectId)` WITHOUT the project metadata, so the
// containment root became `<projectsRoot>/<projectId>` — a directory that does
// not hold the project's files. A relative ref then reported "not found", and
// the same file by absolute path reported "resolves outside the project
// directory". Both argument forms must resolve against the project's real root.
describe('media generate reference image for an imported project', () => {
  let root: string;
  let projectRoot: string;
  let projectsRoot: string;
  let externalDir: string;
  const realFetch = globalThis.fetch;
  const originalMediaConfigDir = process.env.OD_MEDIA_CONFIG_DIR;
  const originalDataDir = process.env.OD_DATA_DIR;
  const originalMinimaxApiKey = process.env.OD_MINIMAX_API_KEY;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'od-external-image-'));
    projectRoot = path.join(root, 'project-root');
    projectsRoot = path.join(projectRoot, '.od', 'projects');
    await mkdir(projectsRoot, { recursive: true });
    // The project's files live here — outside <projectsRoot>/<projectId>.
    externalDir = path.join(root, 'imported-project');
    await mkdir(externalDir, { recursive: true });
    await writeFile(path.join(externalDir, 'ref.png'), Buffer.from(PNG_BASE64, 'base64'));
    delete process.env.OD_MEDIA_CONFIG_DIR;
    delete process.env.OD_DATA_DIR;
    process.env.OD_MINIMAX_API_KEY = 'minimax-test-key';
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (originalMinimaxApiKey == null) {
      delete process.env.OD_MINIMAX_API_KEY;
    } else {
      process.env.OD_MINIMAX_API_KEY = originalMinimaxApiKey;
    }
    if (originalMediaConfigDir == null) {
      delete process.env.OD_MEDIA_CONFIG_DIR;
    } else {
      process.env.OD_MEDIA_CONFIG_DIR = originalMediaConfigDir;
    }
    if (originalDataDir == null) {
      delete process.env.OD_DATA_DIR;
    } else {
      process.env.OD_DATA_DIR = originalDataDir;
    }
    await rm(root, { recursive: true, force: true });
  });

  function stubMiniMaxImageI2I() {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.subject_reference).toEqual([{
        type: 'character',
        image_file: expect.stringMatching(/^data:image\/png;base64,/),
      }]);
      return new Response(JSON.stringify({
        base_resp: { status_code: 0, status_msg: 'success' },
        data: { image_base64: [PNG_BASE64] },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('resolves a project-relative --image against the project baseDir', async () => {
    stubMiniMaxImageI2I();

    const result = await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'imported-1',
      projectMetadata: { baseDir: externalDir },
      surface: 'image',
      model: 'minimax-image-01',
      prompt: 'restyle as ukiyo-e',
      image: 'ref.png',
      output: 'out.png',
    });

    expect(result.name).toBe('out.png');
    // Output lands beside the project's real files, not under projectsRoot.
    const bytes = await readFile(path.join(externalDir, 'out.png'));
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('accepts an absolute --image path inside the project baseDir', async () => {
    stubMiniMaxImageI2I();

    const result = await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'imported-1',
      projectMetadata: { baseDir: externalDir },
      surface: 'image',
      model: 'minimax-image-01',
      prompt: 'restyle as ukiyo-e',
      image: path.join(externalDir, 'ref.png'),
      output: 'out-abs.png',
    });

    expect(result.name).toBe('out-abs.png');
    const bytes = await readFile(path.join(externalDir, 'out-abs.png'));
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('still refuses a reference that escapes the project baseDir', async () => {
    stubMiniMaxImageI2I();

    await expect(generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'imported-1',
      projectMetadata: { baseDir: externalDir },
      surface: 'image',
      model: 'minimax-image-01',
      prompt: 'restyle as ukiyo-e',
      image: '../escape.png',
      output: 'out-escape.png',
    })).rejects.toThrow(/resolves outside the project directory/);
  });
});
