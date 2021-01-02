import assert from 'assert';
import { RawSource, SourceMapSource } from 'webpack-sources';
import { RawSourceMap } from 'source-map';
import { matchObject } from 'webpack/lib/ModuleFilenameHelpers.js';
import webpack from 'webpack';
import { Compiler, MinifyPluginOptions } from './interfaces';

// Messes with TypeScript rootDir
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../package.json');

type Asset = webpack.compilation.Asset;

const isJsFile = /\.js$/i;
const pluginName = 'esbuild-minify';

const flatMap = (
	array: any[],
	callback: (element: any) => any,
) => (
	array.flatMap
		? array.flatMap(callback) // eslint-disable-line unicorn/no-fn-reference-in-iterator
		: [].concat(...array.map(callback)) // eslint-disable-line unicorn/no-fn-reference-in-iterator
);

class ESBuildMinifyPlugin {
	private readonly options: MinifyPluginOptions;

	constructor(options?: MinifyPluginOptions) {
		this.options = { ...options };

		const hasMinify = Object.keys(this.options).some(k => k.startsWith('minify'));
		if (!hasMinify) {
			this.options.minify = true;
		}
	}

	apply(compiler: Compiler): void {
		compiler.hooks.compilation.tap(pluginName, (compilation) => {
			assert(compiler.$esbuildService, '[esbuild-loader] You need to add ESBuildPlugin to your webpack config first');

			const meta = JSON.stringify({
				name: 'esbuild-loader',
				version,
				options: this.options,
			});
			compilation.hooks.chunkHash.tap(pluginName, (_, hash) => hash.update(meta));

			const hooks = (compilation.hooks as any);
			if (hooks.processAssets) {
				hooks.processAssets.tapPromise(
					{
						name: pluginName,
						stage: (compilation.constructor as any).PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE,
					},
					async (assets: Asset[]) => await this.transformAssets(compilation, Object.keys(assets)),
				);

				hooks.statsPrinter.tap(pluginName, (stats: any) => {
					stats.hooks.print
						.for('asset.info.minimized')
						.tap(pluginName, (minimized: boolean, { green, formatFlag }: any) => (minimized ? green(formatFlag('minimized')) : undefined));
				});
			} else {
				compilation.hooks.optimizeChunkAssets.tapPromise(
					pluginName,
					async chunks => await this.transformAssets(
						compilation,
						flatMap(chunks, chunk => chunk.files),
					),
				);
			}
		});
	}

	async transformAssets(
		compilation: webpack.compilation.Compilation,
		assetNames: string[],
	): Promise<void> {
		const {
			options: {
				devtool,
			},
			$esbuildService,
		} = compilation.compiler as Compiler;

		assert($esbuildService, '[esbuild-loader] You need to add ESBuildPlugin to your webpack config first');

		const sourcemap = (
			// TODO: drop support for esbuild sourcemap in future so it all goes through WP API
			this.options.sourcemap === undefined
				? devtool && (devtool as string).includes('source-map')
				: this.options.sourcemap
		);

		const { include, exclude, ...transformOptions } = this.options;

		const transforms = assetNames
			.filter(assetName => isJsFile.test(assetName) && matchObject({ include, exclude }, assetName))
			.map((assetName): [string, Asset] => [
				assetName,
				compilation.getAsset(assetName),
			])
			.map(async ([
				assetName,
				{ info, source: assetSource },
			]) => {
				const { source, map } = assetSource.sourceAndMap();
				const result = await $esbuildService.transform(source.toString(), {
					...transformOptions,
					sourcemap,
					sourcefile: assetName,
				});

				compilation.updateAsset(
					assetName,
					sourcemap
						? new SourceMapSource(
							result.code || '',
							assetName,
							result.map as any,
							source?.toString(),
							(map as RawSourceMap),
							true,
						)
						: new RawSource(result.code || ''),
					{
						...info,
						minimized: true,
					} as any,
				);
			});

		if (transforms.length > 0) {
			await Promise.all(transforms);
		}
	}
}

export default ESBuildMinifyPlugin;
