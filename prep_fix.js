const fs = require('fs');
let path = 'c:/Users/WETCOM/Desktop/Automatizar Operaciones/vsphere/VMsConSnapshots.js';
let content = fs.readFileSync(path, 'utf8');

// Restore idxSnapshotName lookup logic
content = content.replace(
  'let idxSnapshotName = findCol("Snapshot_Name") !== -1 ? findCol("Snapshot_Name") : findCol("Snapshot Name");\\n    if (idxSnapshotName === -1) idxSnapshotName = findCol("Snapshot");\\n    Logger.log("idxSnapshotName resuelto a: " + idxSnapshotName);',
  'let idxSnapshotName = findCol("Name Snapshot");'
);

// We need to do a regex replace because the string might have weird newlines in powershell string literals.
// Let's use string replace for exactly what is there.
