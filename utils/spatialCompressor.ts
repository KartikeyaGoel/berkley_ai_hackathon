import type { CommitState, CompressedLedger } from "@/types/topo";

function buildDictMap(history: CommitState[]): Record<string, string> {
  const dictMap: Record<string, string> = {};
  let labelIdx = 0;
  let statusIdx = 0;

  for (const commit of history) {
    for (const obj of commit.objects) {
      if (!(obj.label in dictMap)) {
        dictMap[obj.label] = `L${labelIdx++}`;
      }
      if (!(obj.status in dictMap)) {
        dictMap[obj.status] = `S${statusIdx++}`;
      }
    }
  }

  return dictMap;
}

function reverseDict(dictMap: Record<string, string>): Record<string, string> {
  const reversed: Record<string, string> = {};
  for (const [key, value] of Object.entries(dictMap)) {
    reversed[value] = key;
  }
  return reversed;
}

export function compressSpatialHistory(history: CommitState[]): CompressedLedger {
  const dictMap = buildDictMap(history);
  const spaceLedger: CompressedLedger["spaceLedger"] = {};

  const objectIds = new Set<string>();
  for (const commit of history) {
    for (const obj of commit.objects) {
      objectIds.add(obj.id);
    }
  }

  for (const objectId of objectIds) {
    const intervals: CompressedLedger["spaceLedger"][string]["intervals"] = [];

    for (const commit of history) {
      const obj = commit.objects.find((o) => o.id === objectId);
      if (!obj) continue;

      const statusToken = dictMap[obj.status] ?? obj.status;
      const last = intervals[intervals.length - 1];

      if (
        last &&
        last.x === obj.x &&
        last.y === obj.y &&
        last.z === obj.z &&
        last.status === statusToken
      ) {
        last.endCommit = commit.commitHash;
      } else {
        intervals.push({
          startCommit: commit.commitHash,
          endCommit: commit.commitHash,
          x: obj.x,
          y: obj.y,
          z: obj.z,
          status: statusToken,
        });
      }
    }

    if (intervals.length > 0) {
      spaceLedger[objectId] = { intervals };
    }
  }

  return { dictMap, spaceLedger };
}

export function decompressSpatialHistory(ledger: CompressedLedger): CommitState[] {
  const reversed = reverseDict(ledger.dictMap);
  const commitHashes = new Set<string>();

  for (const entry of Object.values(ledger.spaceLedger)) {
    for (const interval of entry.intervals) {
      commitHashes.add(interval.startCommit);
      commitHashes.add(interval.endCommit);
    }
  }

  const sortedHashes = Array.from(commitHashes).sort((a, b) => {
    const na = parseInt(a.replace("c", ""), 10);
    const nb = parseInt(b.replace("c", ""), 10);
    return na - nb;
  });

  return sortedHashes.map((commitHash) => {
    const objects = Object.entries(ledger.spaceLedger)
      .map(([id, entry]) => {
        const interval = entry.intervals.find(
          (iv) =>
            parseInt(iv.startCommit.replace("c", ""), 10) <=
              parseInt(commitHash.replace("c", ""), 10) &&
            parseInt(iv.endCommit.replace("c", ""), 10) >=
              parseInt(commitHash.replace("c", ""), 10),
        );
        if (!interval) return null;

        const status = reversed[interval.status] ?? interval.status;
        return {
          id,
          label: id,
          x: interval.x,
          y: interval.y,
          z: interval.z,
          status: status as CommitState["objects"][0]["status"],
          confidence: 1,
        };
      })
      .filter((o): o is NonNullable<typeof o> => o !== null);

    return {
      commitHash,
      timestamp: Date.now(),
      objects,
      reconciliationNotes: "",
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        imageBytesSent: 0,
        regionCropped: false,
      },
    };
  });
}
