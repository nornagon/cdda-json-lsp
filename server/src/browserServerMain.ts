import { createConnection, BrowserMessageReader, BrowserMessageWriter } from 'vscode-languageserver/browser';

import { InitializeParams, InitializeResult, Location, Position, Range, ServerCapabilities, TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLanguageService } from 'vscode-json-languageservice';
import * as Json from "jsonc-parser";
import * as path from 'path';

console.log('running server cdda-json-lsp');

const jsonLanguageService = getLanguageService({});

const messageReader = new BrowserMessageReader(self);
const messageWriter = new BrowserMessageWriter(self);

const connection = createConnection(messageReader, messageWriter);

let ws: string | null | undefined;
connection.onInitialize((params: InitializeParams): InitializeResult => {
	ws = params.rootPath;
	connection.console.log(`ws: ${ws}`);
	const capabilities: ServerCapabilities = {
		definitionProvider: true,
	};
	return { capabilities };
});

const index = new Map<string, Location[]>();

function breakJSONIntoSingleObjects(str: string): { obj: any; start: number; end: number; }[] {
	const objs = [];
	let depth = 0;
	let line = 1;
	let start = -1;
	let startLine = -1;
	let inString = false;
	let inStringEscSequence = false;
	for (let i = 0; i < str.length; i++) {
		const c = str[i];
		if (inString) {
			if (inStringEscSequence) {
				inStringEscSequence = false;
			} else {
				if (c === '\\')
					inStringEscSequence = true;
				else if (c === '"')
					inString = false;
			}
		} else {
			if (c === '{') {
				if (depth === 0) {
					start = i;
					startLine = line;
				}
				depth++;
			} else if (c === '}') {
				depth--;
				if (depth === 0) {
					objs.push({
						obj: JSON.parse(str.slice(start, i + 1)),
						start: startLine,
						end: line,
					});
				}
			} else if (c === "\"") {
				inString = true;
			} else if (c === '\n') {
				line++;
			}
		}
	}
	return objs;
}
  

connection.onInitialized(() => {
	connection.console.info('listing modinfos');
	connection.sendRequest('cdda/findFiles', '**/modinfo.json').then(async uris => {
		for (const uri of uris as any) {
			const content = await connection.sendRequest('cdda/readFile', uri);
			try {
				const contentStr = new TextDecoder().decode(content as any);
				const items = JSON.parse(contentStr);
				const modinfo = items.find((x: any) => x.type === 'MOD_INFO');
				const modRoot = path.join(path.dirname(uri.path), modinfo.path ?? '');
				const relativeModRoot = path.relative(ws!, modRoot);
				const jsonUris = (await connection.sendRequest('cdda/findFiles', relativeModRoot + '/**/*.json')) as any[];
				connection.console.log('reading mod ' + modinfo.name);
				await Promise.all(jsonUris.map(async uri => {
					const contents = await connection.sendRequest('cdda/readFile', uri) as Uint8Array;
					const str = new TextDecoder().decode(contents);
					const objs = breakJSONIntoSingleObjects(str);
					for (const {obj, start, end} of objs) {
						if (obj.id) {
							if (!index.has(obj.id)) index.set(obj.id, []);
							index.get(obj.id)!.push(Location.create(uri._formatted, Range.create(Position.create(start, 0), Position.create(end, 0))));
						}
					}
					/*
					const doc = TextDocument.create(uri, "json", 0, str);
					const json = jsonLanguageService.parseJSONDocument(doc);
					return json;
					*/
				}));
				connection.console.log('done reading mod ' + modinfo.name);
			} catch (e: any) {
				connection.console.error('Error reading mod info at ' + uri.path + ': ' + e.message);
			}
		}
	});
});

// Track open, change and close text document events
const documents = new TextDocuments(TextDocument);
documents.listen(connection);

// Register providers
connection.onDefinition((params) => {
	const document = documents.get(params.textDocument.uri);
	if (document) {
		const parsed = jsonLanguageService.parseJSONDocument(document);
		const offset = document.offsetAt(params.position);
		const node = parsed.getNodeFromOffset(offset);
		if (node?.type === 'string') {
			return index.get(node.value);
		}
		/*
		// Get the top-level object
		let root = node;
		while (root?.parent && root.parent?.parent) root = root.parent;
		connection.console.log(`${root?.toString()}`);
		connection.console.log(`${JSON.stringify(Json.getNodeValue(root!))}`);
		*/
	}
	return [];
});

// Listen on the connection
connection.listen();
