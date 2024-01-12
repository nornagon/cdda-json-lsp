import { createConnection, BrowserMessageReader, BrowserMessageWriter } from 'vscode-languageserver/browser';

import { FileChangeType, InitializeParams, InitializeResult, Location, Range, ServerCapabilities, TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLanguageService } from 'vscode-json-languageservice';
import * as Json from "jsonc-parser";
import * as path from 'path';

const jsonLanguageService = getLanguageService({});

const messageReader = new BrowserMessageReader(self);
const messageWriter = new BrowserMessageWriter(self);

const connection = createConnection(messageReader, messageWriter);

let ws: string | null | undefined;
connection.onInitialize((params: InitializeParams): InitializeResult => {
	ws = params.rootPath; // TODO: multi-workspace
	const capabilities: ServerCapabilities = {
		definitionProvider: true,
		referencesProvider: true,
	};
	return { capabilities };
});

class FileIndex {
	definitions = new Map<string, Location[]>();
	references = new Map<string, Location[]>();

	addDefinition(type: string, id: string, location: Location) {
		if (!this.definitions.has(id)) {
			this.definitions.set(id, []);
		}
		this.definitions.get(id)!.push(location);
	}
	addReference(type: string, id: string, location: Location) {
		if (!this.references.has(id)) {
			this.references.set(id, []);
		}
		this.references.get(id)!.push(location);
	}
}
const fileIndices = new Map<string, FileIndex>();

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

async function indexFile(uri: string) {
	const contents = await connection.sendRequest('cdda/readFile', uri) as Uint8Array;
	const str = new TextDecoder().decode(contents);
	const doc = TextDocument.create(uri, "json", 0, str);
	const parsed = Json.parseTree(str);
	const fileIndex = new FileIndex;
	if (parsed && parsed.type === 'array') {
		for (const obj of parsed.children ?? []) {
			if (obj.type === 'object') {
				const objStart = doc.positionAt(obj.offset);
				const objEnd = doc.positionAt(obj.offset + obj.length);
				const id = obj.children?.find(c => c.type === 'property' && c.children?.[0].value === 'id')?.children?.[1].value;
				const type = obj.children?.find(c => c.type === 'property' && c.children?.[0].value === 'type')?.children?.[1].value;
				if (id && type && typeof id === 'string' && typeof type === 'string') {
					fileIndex.addDefinition(type, id, Location.create(uri, Range.create(objStart, objEnd)));
				}
				walkValues(obj, (n) => {
					if (n.type === 'string') {
						const start = doc.positionAt(n.offset);
						const end = doc.positionAt(n.offset + n.length);
						fileIndex.addReference('', n.value, Location.create(uri, Range.create(start, end)));
					}
				});
			}
		}
	}
	fileIndices.set(uri, fileIndex);
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
				const uriPath = (new URL(uri)).pathname;
				const modRoot = path.join(path.dirname(uriPath), modinfo.path ?? '');
				const relativeModRoot = path.relative(ws!, modRoot);
				const jsonUris = (await connection.sendRequest('cdda/findFiles', relativeModRoot + '/**/*.json')) as any[];
				connection.console.log('reading mod ' + modinfo.name);
				await Promise.all(jsonUris.map(indexFile));
				connection.console.log('done reading mod ' + modinfo.name);
			} catch (e: any) {
				connection.console.error('Error reading mod info at ' + uri + ': ' + e.message);
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
			const results = [];
			for (const idx of fileIndices.values())
				results.push(...idx.definitions.get(node.value) ?? []);
			return results;
		}
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
			const results = [];
			for (const idx of fileIndices.values())
				results.push(...idx.references.get(node.value) ?? []);
			return results;
		}
	}
	return [];
});

connection.onDidChangeWatchedFiles((params) => {
	for (const change of params.changes) {
		if (change.type === FileChangeType.Deleted) {
			fileIndices.delete(change.uri);
		} else { // created/updated
			indexFile(change.uri);
		}
	}
});

// Listen on the connection
connection.listen();
