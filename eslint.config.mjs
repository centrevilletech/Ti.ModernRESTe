import js from '@eslint/js';
import globals from 'globals';

export default [
	{ ignores: ['reste.js', 'split/**', 'node_modules/**', 'dist/**', 'example/build/**', 'example/Resources/**', 'example/app/lib/reste.js', 'example/platform/**', 'example/plugins/**', 'example/i18n/**'] },
	js.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 2020,
			sourceType: 'commonjs',
			globals: { ...globals.node }
		},
		rules: {
			'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],
			'no-var': 'error',
			'prefer-const': 'error',
			eqeqeq: ['error', 'always', { null: 'ignore' }],
			curly: ['error', 'all'],
			'no-throw-literal': 'error',
			'no-prototype-builtins': 'off',
			indent: ['error', 'tab', { SwitchCase: 1 }],
			quotes: ['error', 'single', { avoidEscape: true }],
			semi: ['error', 'always']
		}
	},
	{
		// The library runs inside Titanium: no Node globals, only what Titanium and Alloy provide.
		files: ['src/**/*.js'],
		languageOptions: {
			ecmaVersion: 2017,
			globals: {
				Ti: 'readonly', Alloy: 'readonly', Backbone: 'readonly', console: 'readonly', setTimeout: 'readonly',
				clearTimeout: 'readonly', module: 'writable', require: 'readonly', WeakRef: 'readonly'
			}
		},
		rules: { 'no-restricted-globals': ['error', 'process', 'Buffer', 'global', '__dirname'] }
	},
	{
		files: ['test/**/*.js', 'bench/**/*.js'],
		languageOptions: { globals: { Ti: 'writable', Alloy: 'writable', Backbone: 'writable' } }
	},
	{
		files: ['example/app/**/*.js'],
		languageOptions: {
			globals: {
				Ti: 'readonly', Alloy: 'readonly', Backbone: 'readonly', _: 'readonly', $: 'writable', arguments: 'readonly',
				OS_ANDROID: 'readonly', OS_IOS: 'readonly', ENV_DEV: 'readonly', ENV_PRODUCTION: 'readonly', $model: 'readonly'
			}
		},
		rules: { 'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^(on[A-Z]|transform|filter|do[A-Z])' }] }
	},
	{
		files: ['eslint.config.mjs'],
		languageOptions: { sourceType: 'module' }
	}
];
