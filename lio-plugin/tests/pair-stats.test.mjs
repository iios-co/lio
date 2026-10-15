import { test } from "node:test";
import assert from "node:assert/strict";
import { diffTrees, linkCount, describeDiff } from "../src/lib/treeDiff.ts";

test("pair stats for Everything pair with identical 838-link / 229-folder trees reports Synced and 0 differ", () => {
  // Simulate 838 links and 229 folders (1067 total nodes)
  const localTree = [];
  const serverTree = [];

  for (let f = 0; f < 229; f++) {
    const folderId = `fld_${f}`;
    const parentId = f === 0 ? "1" : `fld_${Math.floor((f - 1) / 2)}`;
    const folder = {
      id: folderId,
      parentId,
      index: f,
      title: `Folder ${f}`,
      url: null,
      isFolder: true,
    };
    localTree.push({ ...folder });
    serverTree.push({ ...folder });
  }

  for (let b = 0; b < 838; b++) {
    const parentFolder = `fld_${b % 229}`;
    const bm = {
      id: `bm_${b}`,
      parentId: parentFolder,
      index: Math.floor(b / 229),
      title: `Bookmark ${b}`,
      url: `https://example.com/page/${b}`,
      isFolder: false,
    };
    localTree.push({ ...bm });
    serverTree.push({ ...bm });
  }

  assert.equal(localTree.length, 1067);
  assert.equal(serverTree.length, 1067);
  assert.equal(linkCount(localTree), 838);
  assert.equal(linkCount(serverTree), 838);

  const diff = diffTrees(localTree, serverTree);
  assert.equal(diff.identical, true);
  assert.equal(diff.differences, 0);
  assert.equal(diff.localLinks, 838);
  assert.equal(diff.serverLinks, 838);
  assert.equal(describeDiff(diff), "Every link, name and position matches.");

  // Regression check: If unmapped local browser IDs were mistakenly passed instead of
  // canonical server IDs (e.g. "14", "15" instead of "bm_0", "fld_0"), differences would be 2134:
  const rawLocalUnmapped = localTree.map((n, i) => ({ ...n, id: `local_${i}` }));
  const unmappedDiff = diffTrees(rawLocalUnmapped, serverTree);
  assert.equal(unmappedDiff.differences, 2134);
  assert.equal(unmappedDiff.identical, false);
});
