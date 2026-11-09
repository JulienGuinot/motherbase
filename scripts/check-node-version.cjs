#!/usr/bin/env node

const minimum = [22, 12, 0];
const current = process.versions.node.split('.').map(Number);

const compare = (left, right) => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }

  return 0;
};

if (compare(current, minimum) < 0) {
  console.error(
    `Node ${process.versions.node} detected. This project requires Node >=${minimum.join('.')}. ` +
      'Install Node 22+ on the VPS, then reinstall dependencies.'
  );
  process.exit(1);
}
