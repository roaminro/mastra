import type { IMastraLogger } from '@mastra/core/logger';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import nodeResolve from '@rollup/plugin-node-resolve';
import virtual from '@rollup/plugin-virtual';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rollup, type OutputAsset, type OutputChunk, type Plugin } from 'rollup';
import esbuild from 'rollup-plugin-esbuild';
import { isNodeBuiltin } from './isNodeBuiltin';
import { aliasHono } from './plugins/hono-alias';
import { removeDeployer } from './plugins/remove-deployer';
import { join } from 'node:path';
import { validate } from '../validator/validate';
import { tsConfigPaths } from './plugins/tsconfig-paths';
import { writeFile } from 'node:fs/promises';
import { getBundlerOptions } from './bundlerOptions';

// TODO: Make thie extendable or find a rollup plugin that can do this
const globalExternals = [
  'pino',
  'pino-pretty',
  '@libsql/client',
  'pg',
  'libsql',
  'jsdom',
  'sqlite3',
  'fastembed',
  'nodemailer',
  '#tools',
];

function findExternalImporter(module: OutputChunk, external: string, allOutputs: OutputChunk[]): OutputChunk | null {
  const capturedFiles = new Set();

  for (const id of module.imports) {
    if (id === external) {
      return module;
    } else {
      if (id.endsWith('.mjs')) {
        capturedFiles.add(id);
      }
    }
  }

  for (const file of capturedFiles) {
    const nextModule = allOutputs.find(o => o.fileName === file);
    if (nextModule) {
      const importer = findExternalImporter(nextModule, external, allOutputs);

      if (importer) {
        return importer;
      }
    }
  }

  return null;
}

/**
 * Analyzes the entry file to identify dependencies that need optimization.
 * This is the first step of the bundle analysis process.
 *
 * @param entry - The entry file path or content
 * @param mastraEntry - The mastra entry point
 * @param isVirtualFile - Whether the entry is a virtual file (content string) or a file path
 * @param platform - Target platform (node or browser)
 * @param logger - Logger instance for debugging
 * @returns Map of dependencies to optimize with their exported bindings
 */
async function analyze(
  entry: string,
  mastraEntry: string,
  isVirtualFile: boolean,
  platform: 'node' | 'browser',
  logger: IMastraLogger,
  sourcemapEnabled: boolean = false,
) {
  logger.info('Analyzing dependencies...');
  let virtualPlugin = null;
  if (isVirtualFile) {
    virtualPlugin = virtual({
      '#entry': entry,
    });
    entry = '#entry';
  }

  const normalizedMastraEntry = mastraEntry.replaceAll('\\', '/');
  const optimizerBundler = await rollup({
    logLevel: process.env.MASTRA_BUNDLER_DEBUG === 'true' ? 'debug' : 'silent',
    input: isVirtualFile ? '#entry' : entry,
    treeshake: 'smallest',
    preserveSymlinks: true,
    plugins: [
      virtualPlugin,
      tsConfigPaths(),
      {
        name: 'custom-alias-resolver',
        resolveId(id: string) {
          if (id === '#server') {
            return fileURLToPath(import.meta.resolve('@mastra/deployer/server')).replaceAll('\\', '/');
          }
          if (id === '#mastra') {
            return normalizedMastraEntry;
          }
          if (id.startsWith('@mastra/server')) {
            return fileURLToPath(import.meta.resolve(id));
          }

          // Tools is generated dependency, we don't want it to be handled by the bundler but instead read from disk at runtime
          if (id === '#tools') {
            return {
              id: '#tools',
              external: true,
            };
          }
        },
      } satisfies Plugin,
      json(),
      esbuild({
        target: 'node20',
        platform,
        minify: false,
      }),
      commonjs({
        strictRequires: 'debug',
        ignoreTryCatch: false,
        transformMixedEsModules: true,
        extensions: ['.js', '.ts'],
      }),
      removeDeployer(normalizedMastraEntry, { sourcemap: sourcemapEnabled }),
      esbuild({
        target: 'node20',
        platform,
        minify: false,
      }),
    ].filter(Boolean),
  });

  const { output } = await optimizerBundler.generate({
    format: 'esm',
    inlineDynamicImports: true,
  });

  await optimizerBundler.close();

  const depsToOptimize = new Map(Object.entries(output[0].importedBindings));
  for (const dep of depsToOptimize.keys()) {
    if (isNodeBuiltin(dep)) {
      depsToOptimize.delete(dep);
    }
  }

  for (const o of output) {
    if (o.type !== 'chunk') {
      continue;
    }

    // Tools is generated dependency, we don't want our analyzer to handle it
    const dynamicImports = o.dynamicImports.filter(d => d !== '#tools');
    if (!dynamicImports.length) {
      continue;
    }

    console.log(dynamicImports);

    for (const dynamicImport of dynamicImports) {
      if (!depsToOptimize.has(dynamicImport) && !isNodeBuiltin(dynamicImport)) {
        depsToOptimize.set(dynamicImport, ['*']);
      }
    }
  }

  return depsToOptimize;
}

/**
 * Bundles vendor dependencies identified in the analysis step.
 * Creates virtual modules for each dependency and bundles them using rollup.
 *
 * @param depsToOptimize - Map of dependencies with their exports from analyze step
 * @param outputDir - Directory where bundled files will be written
 * @param logger - Logger instance for debugging
 * @returns Object containing bundle output and reference map for validation
 */
async function bundleExternals(
  depsToOptimize: Map<string, string[]>,
  outputDir: string,
  logger: IMastraLogger,
  customExternals?: string[],
) {
  logger.info('Optimizing dependencies...');
  logger.debug(
    `${Array.from(depsToOptimize.keys())
      .map(key => `- ${key}`)
      .join('\n')}`,
  );

  const allExternals = [...globalExternals, ...(customExternals || [])];
  const reverseVirtualReferenceMap = new Map<string, string>();
  const virtualDependencies = new Map();
  for (const [dep, exports] of depsToOptimize.entries()) {
    const name = dep.replaceAll('/', '-');
    reverseVirtualReferenceMap.set(name, dep);

    const virtualFile: string[] = [];
    let exportStringBuilder = [];
    for (const local of exports) {
      if (local === '*') {
        virtualFile.push(`export * from '${dep}';`);
      } else if (local === 'default') {
        virtualFile.push(`export { default } from '${dep}';`);
      } else {
        exportStringBuilder.push(local);
      }
    }

    if (exportStringBuilder.length > 0) {
      virtualFile.push(`export { ${exportStringBuilder.join(', ')} } from '${dep}';`);
    }

    virtualDependencies.set(dep, {
      name,
      virtual: virtualFile.join('\n'),
    });
  }

  const bundler = await rollup({
    logLevel: process.env.MASTRA_BUNDLER_DEBUG === 'true' ? 'debug' : 'silent',
    input: Array.from(virtualDependencies.entries()).reduce(
      (acc, [dep, virtualDep]) => {
        acc[virtualDep.name] = `#virtual-${dep}`;
        return acc;
      },
      {} as Record<string, string>,
    ),
    // this dependency breaks the build, so we need to exclude it
    // TODO actually fix this so we don't need to exclude it
    external: allExternals,
    treeshake: 'smallest',
    plugins: [
      virtual(
        Array.from(virtualDependencies.entries()).reduce(
          (acc, [dep, virtualDep]) => {
            acc[`#virtual-${dep}`] = virtualDep.virtual;
            return acc;
          },
          {} as Record<string, string>,
        ),
      ),
      commonjs({
        strictRequires: 'strict',
        transformMixedEsModules: true,
        ignoreTryCatch: false,
      }),
      nodeResolve({
        preferBuiltins: true,
        exportConditions: ['node'],
      }),
      // hono is imported from deployer, so we need to resolve from here instead of the project root
      aliasHono(),
      json(),
    ].filter(Boolean),
  });

  const { output } = await bundler.write({
    format: 'esm',
    dir: outputDir,
    entryFileNames: '[name].mjs',
    chunkFileNames: '[name].mjs',
    hoistTransitiveImports: false,
  });
  const moduleResolveMap = {} as Record<string, Record<string, string>>;
  const filteredChunks = output.filter(o => o.type === 'chunk');

  for (const o of filteredChunks.filter(o => o.isEntry || o.isDynamicEntry)) {
    for (const external of allExternals) {
      if (external === '#tools') {
        continue;
      }

      const importer = findExternalImporter(o, external, filteredChunks);

      if (importer) {
        const fullPath = join(outputDir, importer.fileName);
        moduleResolveMap[fullPath] = moduleResolveMap[fullPath] || {};
        if (importer.moduleIds.length) {
          moduleResolveMap[fullPath][external] = importer.moduleIds[importer.moduleIds.length - 1]?.startsWith(
            '\x00virtual:#virtual',
          )
            ? importer.moduleIds[importer.moduleIds.length - 2]!
            : importer.moduleIds[importer.moduleIds.length - 1]!;
        }
      }
    }
  }

  await writeFile(join(outputDir, 'module-resolve-map.json'), JSON.stringify(moduleResolveMap, null, 2));

  await bundler.close();

  return { output, reverseVirtualReferenceMap, usedExternals: moduleResolveMap };
}

/**
 * Validates the bundled output by attempting to import each generated module.
 * Tracks invalid chunks and external dependencies that couldn't be bundled.
 *
 * @param output - Bundle output from rollup
 * @param reverseVirtualReferenceMap - Map to resolve virtual module names back to original deps
 * @param outputDir - Directory containing the bundled files
 * @param logger - Logger instance for debugging
 * @returns Analysis result containing invalid chunks and dependency mappings
 */
async function validateOutput(
  {
    output,
    reverseVirtualReferenceMap,
    usedExternals,
    outputDir,
  }: {
    output: (OutputChunk | OutputAsset)[];
    reverseVirtualReferenceMap: Map<string, string>;
    usedExternals: Record<string, Record<string, string>>;
    outputDir: string;
  },
  logger: IMastraLogger,
) {
  const result = {
    invalidChunks: new Set<string>(),
    dependencies: new Map<string, string>(),
    externalDependencies: new Set<string>(),
  };

  // we should resolve the version of the deps
  for (const deps of Object.values(usedExternals)) {
    for (const dep of Object.keys(deps)) {
      result.externalDependencies.add(dep);
    }
  }

  for (const file of output) {
    if (file.type === 'asset') {
      continue;
    }

    try {
      logger.debug(`Validating if ${file.fileName} is a valid module.`);
      if (file.isEntry && reverseVirtualReferenceMap.has(file.name)) {
        result.dependencies.set(reverseVirtualReferenceMap.get(file.name)!, file.fileName);
      }

      if (!file.isDynamicEntry && file.isEntry) {
        // validate if the chunk is actually valid, a failsafe to make sure bundling didn't make any mistakes
        await validate(join(outputDir, file.fileName));
      }
    } catch (err) {
      result.invalidChunks.add(file.fileName);
      if (file.isEntry && reverseVirtualReferenceMap.has(file.name)) {
        const reference = reverseVirtualReferenceMap.get(file.name)!;
        const dep = reference.startsWith('@') ? reference.split('/').slice(0, 2).join('/') : reference.split('/')[0];

        result.externalDependencies.add(dep!);
      }

      // we might need this on other projects but not sure so let's keep it commented out for now
      // console.log(file.fileName, file.isEntry, file.isDynamicEntry, err);
      // result.invalidChunks.add(file.fileName);
      // const externalImports = excludeInternalDeps(file.imports.filter(file => !internalFiles.has(file)));
      // externalImports.push(...excludeInternalDeps(file.dynamicImports.filter(file => !internalFiles.has(file))));
      // for (const externalImport of externalImports) {
      //   result.externalDependencies.add(externalImport);
      // }

      // if (reverseVirtualReferenceMap.has(file.name)) {
      //   result.externalDependencies.add(reverseVirtualReferenceMap.get(file.name)!);
      // }
    }
  }

  return result;
}

/**
 * Main bundle analysis function that orchestrates the three-step process:
 * 1. Analyze dependencies
 * 2. Bundle dependencies modules
 * 3. Validate generated bundles
 *
 * This helps identify which dependencies need to be externalized vs bundled.
 */
export async function analyzeBundle(
  entries: string[],
  mastraEntry: string,
  outputDir: string,
  platform: 'node' | 'browser',
  logger: IMastraLogger,
  sourcemapEnabled: boolean = false,
) {
  const depsToOptimize = new Map<string, string[]>();
  for (const entry of entries) {
    const isVirtualFile = entry.includes('\n') || !existsSync(entry);
    const analyzeResult = await analyze(entry, mastraEntry, isVirtualFile, platform, logger, sourcemapEnabled);

    for (const [dep, exports] of analyzeResult.entries()) {
      if (depsToOptimize.has(dep)) {
        // Merge with existing exports if dependency already exists
        const existingExports = depsToOptimize.get(dep)!;
        depsToOptimize.set(dep, [...new Set([...existingExports, ...exports])]);
      } else {
        depsToOptimize.set(dep, exports);
      }
    }
  }
  const customExternals = (await getBundlerOptions(mastraEntry, outputDir))?.externals;

  const { output, reverseVirtualReferenceMap, usedExternals } = await bundleExternals(
    depsToOptimize,
    outputDir,
    logger,
    customExternals,
  );
  const result = await validateOutput({ output, reverseVirtualReferenceMap, usedExternals, outputDir }, logger);

  return result;
}
