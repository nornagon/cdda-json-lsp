import { ExtensionContext, Uri } from 'vscode';
import { LanguageClientOptions } from 'vscode-languageclient';

import { LanguageClient } from 'vscode-languageclient/browser';
import * as vscode from 'vscode';

export async function activate(context: ExtensionContext) {
	console.log('cdda-json-lsp activated!');

	const documentSelector = [{ language: 'json' }];
	const clientOptions: LanguageClientOptions = {
		documentSelector,
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher("**/*.json")
		},
		initializationOptions: {},
		traceOutputChannel: vscode.window.createOutputChannel('CDDA Trace')
	};

	const client = createWorkerLanguageClient(context, clientOptions);

	context.subscriptions.push(client.onRequest("cdda/findFiles", async (arg) => {
		return (await vscode.workspace.findFiles(arg, 'android' /* HACK: properly ignore symlinks */)).map(u => u.toString());
	}));

	context.subscriptions.push(client.onRequest("cdda/readFile", async (arg) => {
		return vscode.workspace.fs.readFile(Uri.parse(arg));
	}));

	context.subscriptions.push(client.onDidChangeState((e) => {
		console.log('[cdda] cdda-json-lsp server is ' + e.newState);
	}));
	await client.start();
}

function createWorkerLanguageClient(context: ExtensionContext, clientOptions: LanguageClientOptions) {
	const serverMain = Uri.joinPath(context.extensionUri, 'server/dist/browserServerMain.js');
	const worker = new Worker(serverMain.toString(true));

	return new LanguageClient('cdda-json-lsp', 'CDDA JSON LSP', clientOptions, worker);
}
