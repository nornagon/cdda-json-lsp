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
		referencesProvider: true,
	};
	return { capabilities };
});

const definitions = new Map<string, Location[]>();

function addDefinition(type: string, id: string, location: Location) {
	if (!definitions.has(id)) {
		definitions.set(id, []);
	}
	definitions.get(id)!.push(location);
}

const references = new Map<string, Location[]>();

function addReference(type: string, id: string, location: Location) {
	if (!definitions.has(id)) {
		definitions.set(id, []);
	}
	definitions.get(id)!.push(location);
}

function walkValues(node: Json.Node, f: (n: Json.Node) => void) {
	f(node);
	if (node.type === 'object') {
		for (const property of node.children ?? []) {
			if (property.type === 'property') {
				if (property.children)
					walkValues(property.children[1], f);
			}
		}
	} else if (node.type === 'array') {
		for (const value of node.children ?? []) {
			walkValues(value, f);
		}
	}
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
					const doc = TextDocument.create(uri, "json", 0, str);
					const parsed = Json.parseTree(str);
					if (parsed && parsed.type === 'array') {
						for (const obj of parsed.children ?? []) {
							if (obj.type === 'object') {
								const objStart = doc.positionAt(obj.offset);
								const objEnd = doc.positionAt(obj.offset + obj.length);
								const id = obj.children?.find(c => c.type === 'property' && c.children?.[0].value === 'id')?.children?.[1].value;
								const type = obj.children?.find(c => c.type === 'property' && c.children?.[0].value === 'type')?.children?.[1].value;
								if (id && type && typeof id === 'string' && typeof type === 'string') {
									addDefinition(type, id, Location.create(uri._formatted, Range.create(objStart, objEnd)));
								}
								walkValues(obj, (n) => {
									if (n.type === 'string') {
										const start = doc.positionAt(n.offset);
										const end = doc.positionAt(n.offset + n.length);
										addReference('', n.value, Location.create(uri._formatted, Range.create(start, end)));
									}
								});
							}
						}
					}
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
			return definitions.get(node.value);
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

connection.onReferences((params) => {
	const document = documents.get(params.textDocument.uri);
	if (document) {
		const parsed = jsonLanguageService.parseJSONDocument(document);
		const offset = document.offsetAt(params.position);
		const node = parsed.getNodeFromOffset(offset);
		if (node?.type === 'string') {
			return references.get(node.value);
		}
	}
	return [];
});

// Listen on the connection
connection.listen();
