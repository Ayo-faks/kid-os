import { existsSync, readFileSync, writeFileSync } from 'node:fs';

function updatePackage(packagePath, exportsMap) {
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  packageJson.main = './dist/index.js';
  packageJson.types = './dist/index.d.ts';
  packageJson.exports = exportsMap;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

updatePackage('packages/contracts/package.json', {
  '.': {
    types: './dist/index.d.ts',
    import: './dist/index.js',
    default: './dist/index.js',
  },
  './workflow': {
    types: './dist/workflow.d.ts',
    import: './dist/workflow.js',
    default: './dist/workflow.js',
  },
});

if (existsSync('packages/object-storage/package.json')) {
  updatePackage('packages/object-storage/package.json', {
    '.': {
      types: './dist/index.d.ts',
      import: './dist/index.js',
      default: './dist/index.js',
    },
  });
}

updatePackage('packages/schemas/package.json', {
  '.': {
    types: './dist/index.d.ts',
    import: './dist/index.js',
    default: './dist/index.js',
  },
  './runtime': {
    types: './dist/runtime.d.ts',
    import: './dist/runtime.js',
    default: './dist/runtime.js',
  },
  './schemas/*': './schemas/*',
});
