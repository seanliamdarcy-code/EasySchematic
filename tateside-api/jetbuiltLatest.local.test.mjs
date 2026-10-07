import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeJetbuiltIndex, listLatestJetbuiltProjects } from '../dist-tateside-api/tateside-api/src/jetbuilt.js';

test('latest projects sort deterministically and paginate the complete cached index', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jetbuilt-latest-'));
  try {
    const indexPath = path.join(root, 'index.json');
    const projects = Array.from({ length: 73 }, (_, i) => ({
      id: String(i).padStart(3, '0'), name: `Project ${i}`, updatedAt: i < 70 ? '2026-10-07' : null,
    })).reverse();
    writeFileSync(indexPath, JSON.stringify({ syncedAt: new Date().toISOString(), clients: [], projects }));
    initializeJetbuiltIndex({
      apiKey: 'fixture', indexPath, refreshMs: 3_600_000, maxRetries: 0,
      fetchImpl: async () => { throw new Error('Fixture blocks external requests'); },
    });
    const first = listLatestJetbuiltProjects();
    const second = listLatestJetbuiltProjects(50, 50);
    assert.equal(first.length, 50);
    assert.equal(second.length, 23);
    assert.deepEqual([...first, ...second].map(p => p.id), projects.map(p => p.id).sort());
    assert.equal(listLatestJetbuiltProjects(50, 73).length, 0);
    assert.equal(listLatestJetbuiltProjects(999, -5).length, 50);
    assert.deepEqual(listLatestJetbuiltProjects(NaN, NaN), first);
    assert.deepEqual(listLatestJetbuiltProjects(2.9, 1.9).map(p => p.id), ['001', '002']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
