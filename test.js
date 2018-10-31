'use strict';

const {createServer, ServerResponse} = require('http');
const {createHash} = require('crypto');
const {promisify} = require('util');

const fetch = require('node-fetch');
const insertHtmlContent = require('.');
const noop = require('lodash/noop');
const test = require('tape');

test('insertHtmlContent()', async t => {
	const server = createServer((req, res) => {
		if (req.url.endsWith('html/')) {
			const html = Buffer.from('<html ⚡><head></head><body></body></html>');

			insertHtmlContent(res, '🐡a🐠蓺');
			res.writeHead(200, {
				'Content-Type': 'text/html',
				'Content-Length': `${Buffer.byteLength(html)}`,
				Etag: 'W/"5b61d9cd-2f857"'
			});
			res.end(html);
			return;
		}

		if (req.url.endsWith('double-body/')) {
			const html = '<html><head></head><body class="foo"><!-- -->🏖</body><body></body></html>';

			res.setHeader('CONTENT-TYPE', 'text/html');
			res.setHeader('CONTENT-LENGTH', `${Buffer.byteLength(html)}`);
			res.setHeader('ETAG', 'abc');
			insertHtmlContent(res, '\x07', {insertToEnd: true});
			res.setHeader('unrelated', 'header');
			res.setHeader('SET-COOKIE', ['type=ninja', 'language=javascript']);

			res.write(html);
			res.end(noop);
			return;
		}

		if (req.url.endsWith('no-content-length/')) {
			res.setHeader('Content-typE', 'text/html');
			insertHtmlContent(res, '\t\n☺️', {tagName: 'head'});
			res.write(Buffer.from('<!doctype html>'));
			res.write(Buffer.alloc(0));
			res.write(Buffer.from('\n'));
			res.write(Buffer.concat([Buffer.from('<HEAD><TITLE>'), Buffer.from([0xC2])], 14), noop);
			res.write(Buffer.alloc(0));
			res.write(Buffer.concat([Buffer.from([0xA2]), Buffer.from('</TITLE></HEAD><')], 17));
			res.write('BODY>', () => res.write('</BODY>', () => res.end()));
			return;
		}

		if (req.url.endsWith('headers-sent/')) {
			res.writeHead(200, {'conteNT-TYpe': 'text/html'});
			insertHtmlContent(res, 'this content should not be inserted');
			res.end('<body></body>');
			return;
		}

		if (req.url.endsWith('non-utf8-encoding/')) {
			res.setHeader('content-type', 'text/html');
			insertHtmlContent(res, '_');

			res.on('error', ({message}) => {
				res.write(message, noop);
				res.end();
			}).write('🌊🏄‍🌊', 'ascii');
			return;
		}

		if (req.url.endsWith('plain-text/')) {
			res.setHeader('content-length', 2);
			res.setHeader('Etag', 'original-etag');
			insertHtmlContent(res, 'c');
			res.setHeader('content-type', 'text/plain');
			res.writeHead(200);
			res.write('a');
			res.end('b');
			return;
		}

		if (req.url.endsWith('plain-text-with-body/')) {
			res.setHeader('content-type', 'text/plain');
			res.setHeader('content-length', 7);
			insertHtmlContent(res, '</body>');
			res.end('<body>');
			return;
		}

		if (req.url.endsWith('invalid-utf8/')) {
			res.on('error', ({message}) => res.end(message));
			insertHtmlContent(res, '');
			res.writeHead(200, {'content-type': 'text/html'});
			res.end(Buffer.from([0xAC]));
			return;
		}

		if (req.url.endsWith('invalid-content-type/')) {
			res.on('error', ({message}) => res.end(message));
			insertHtmlContent(res, '');
			res.writeHead(200, {'content-type': 'ttxxtt'});
			return;
		}

		if (req.url.endsWith('negative-content-length/')) {
			res.on('error', ({message}) => res.end(message));
			insertHtmlContent(res, '');
			res.writeHead(200, {
				'content-type': 'text/html',
				'content-length': -100
			});
			return;
		}

		res.on('error', ({message}) => res.end(message));
		insertHtmlContent(res, '?');
		res.setHeader('content-type', 'text/html');
		res.setHeader('content-length', '0_0');
	});

	await promisify(server.listen.bind(server))(3018);
	await Promise.all([
		(async () => {
			t.equal(
				await (await fetch('http://localhost:3018/html/')).text(),
				'<html ⚡><head></head><body>🐡a🐠蓺</body></html>',
				'should inject contents to the <body> tag.'
			);
		})(),
		(async () => {
			const response = await fetch('http://localhost:3018/double-body/');

			t.equal(
				await response.text(),
				'<html><head></head><body class="foo"><!-- -->🏖\x07</body><body></body></html>',
				'should inject contents to only the first appeared tag.'
			);

			t.equal(
				response.headers.get('etag'),
				`abc${createHash('md5').update('\x07').digest('base64')}`,
				'should modify Etag if HTML response has `Etag` header.'
			);
		})(),
		(async () => {
			const response = await fetch('http://localhost:3018/no-content-length/');

			t.equal(
				await response.text(),
				'<!doctype html>\n<HEAD>\t\n☺️<TITLE>¢</TITLE></HEAD><BODY></BODY>',
				'should support response without Content-Length header.'
			);

			t.notOk(
				response.headers.has('etag'),
				'should not add Etag if the response has no `Etag` header.'
			);
		})(),
		(async () => {
			t.equal(
				await (await fetch('http://localhost:3018/headers-sent/')).text(),
				'<body></body>',
				'should do nothing when the headers has been already sent.'
			);
		})(),
		(async () => {
			t.equal(
				await (await fetch('http://localhost:3018/non-utf8-encoding/')).text(),
				'HTML must be UTF-8 encoded https://github.com/w3c/html/pull/1273, but encoded in ascii.',
				'should invalidate non UTF-8 HTML.'
			);
		})(),
		(async () => {
			const response = await fetch('http://localhost:3018/plain-text/');

			t.equal(
				await response.text(),
				'ab',
				'should ignore non-HTML responses.'
			);

			t.equal(
				response.headers.get('etag'),
				'original-etag',
				'should not modify Etag of non-HTML responses.'
			);
		})(),
		(async () => {
			t.equal(
				await (await fetch('http://localhost:3018/plain-text-with-body/')).text(),
				'<body>',
				'should ignore non-HTML responses even if it has <body> tag.'
			);
		})(),
		(async () => {
			t.equal(
				await (await fetch('http://localhost:3018/invalid-utf8/')).text(),
				'The HTML cannot be encoded to a valid UTF-8 character sequence.',
				'should make response emit an error when it includes an invalid UTF-8 sequence.'
			);
		})(),
		(async () => {
			t.equal(
				await (await fetch('http://localhost:3018/invalid-content-type/')).text(),
				'\'ttxxtt\' is not a valid value for content-type header: invalid media type.',
				'should make response emit an error when it has an invalid content-type.'
			);
		})(),
		(async () => {
			t.equal(
				await (await fetch('http://localhost:3018/negative-content-length/')).text(),
				'According to RFC7230, content-length header must be a non-negative integer' +
				' https://tools.ietf.org/html/rfc7230#section-3.3.2, but it was -100.',
				'should make response emit an error when it has an invalid content-length.'
			);
		})(),
		(async () => {
			t.equal(
				await (await fetch('http://localhost:3018/invalid-content-length/')).text(),
				'According to RFC7230, content-length header must be a non-negative integer' +
				' https://tools.ietf.org/html/rfc7230#section-3.3.2, but it was \'0_0\'.',
				'should make response emit an error when it has a non-integer content-length.'
			);
		})()
	]);
	await promisify(server.close.bind(server))();

	t.end();
});

test('Argument validation', t => {
	t.throws(
		() => insertHtmlContent(new Set(), '.'),
		/^TypeError.*Expected a ServerResponse object, but got Set \{\}\./u,
		'should fail when the first argument is not a ServerResponse.'
	);

	t.throws(
		() => insertHtmlContent(new ServerResponse({}), new Uint32Array()),
		/^TypeError.*Expected a <string> to inject into HTML as the last child of `head` tag, but got a non-string value Uint32Array \[\]\./u,
		'should fail when the second argument is neither a string nor Buffer.'
	);

	t.throws(
		() => insertHtmlContent(new ServerResponse({}), '.', new Int16Array()),
		/^TypeError.*Expected an <Object> to set inject-html-content options, but got Int16Array \[\]\./u,
		'should fail when the third argument is not a plain object.'
	);

	t.throws(
		() => insertHtmlContent(new ServerResponse({}), '.', {tagName: new URLSearchParams()}),
		/^TypeError.*Expected `tagName` option to be an HTML tag name \(<string>\), but got a non-string value URLSearchParams \{\}\./u,
		'should fail when `tagName` option is not a string.'
	);

	t.throws(
		() => insertHtmlContent(new ServerResponse({}), '.', {tagName: ''}),
		/^Error.*Expected `tagName` option to be an HTML tag name, but got '' \(empty string\)\./u,
		'should fail when `tagName` option is an empty string.'
	);

	t.throws(
		() => insertHtmlContent(new ServerResponse({}), '.', {tagName: '\r'}),
		/^Error.*Expected `tagName` option to be an HTML tag name, but got a whitespace-only string '\\r'\./u,
		'should fail when `tagName` option is a whitespace-only string.'
	);

	t.throws(
		() => insertHtmlContent(new ServerResponse({}), '.', {tagName: 'mai n'}),
		/^Error.*Expected `tagName` option to be an HTML tag name, but got an invalid tag name 'mai n'\./u,
		'should fail when `tagName` option is a non-tag-name string.'
	);

	t.throws(
		() => insertHtmlContent(new ServerResponse({}), '.', {insertToEnd: []}),
		/^TypeError.*Expected `insertToEnd` option to be a boolean, but got a non-boolean value \[\] \(array\)\./u,
		'should fail when `insertToEnd` option is a non-boolean value.'
	);

	t.throws(
		() => insertHtmlContent(),
		/^RangeError.*Expected 2 or 3 arguments \(<http\.ServerResponse>, <string>\[, <Object>\]\), but got no arguments\./u,
		'should throw an error when it takes no arguments.'
	);

	t.throws(
		() => insertHtmlContent(new ServerResponse({}), '.', {}, '.'),
		/^RangeError.*Expected 2 or 3 arguments \(<http\.ServerResponse>, <string>\[, <Object>\]\), but got 4 arguments\./u,
		'should throw an error when it takes too many arguments.'
	);

	t.end();
});

test('InsertHtmlContent class', t => {
	const response = new ServerResponse({});
	response.setHeader('content-type', 'text/html');
	response.setHeader('etag', 'qwerty');

	const insertHtmlContentFromClass = new insertHtmlContent.InsertHtmlContent('A');
	insertHtmlContentFromClass(response);

	response.end('<body></Body>');
	response.emit('finish');

	t.equal(
		response.getHeader('etag'),
		`qwerty${createHash('md5').update('A').digest('base64')}`,
		'should create a new function with the fixed `contents` argument.',
	);

	t.throws(
		() => insertHtmlContentFromClass(),
		/RangeError.*Expected 1 argument \(<http\.ServerResponse>\), but got no arguments\./u,
		'should throw an error when it takes no arguments.'
	);

	t.throws(
		() => insertHtmlContentFromClass('123', 1),
		/RangeError.*Expected 1 argument \(<http\.ServerResponse>\), but got 2 arguments\./u,
		'should throw an error when it takes too many arguments.'
	);

	t.end();
});

test('Argument validation of InsertHtmlContent class', t => {
	t.throws(
		() => new insertHtmlContent.InsertHtmlContent(Symbol('x')),
		/^TypeError.*Expected a <string> to inject into HTML as the last child of `head` tag, but got a non-string value Symbol\(x\)\./u,
		'should fail when the argument is not a Buffer.'
	);

	t.throws(
		() => new insertHtmlContent.InsertHtmlContent(),
		/^RangeError.*Expected 1 or 2 arguments \(<string>\[, <Object>\]\), but got no arguments\./u,
		'should fail when it takes no arguments.'
	);

	t.throws(
		() => new insertHtmlContent.InsertHtmlContent('/', {}, {}),
		/^RangeError.*Expected 1 or 2 arguments \(<string>\[, <Object>\]\), but got 3 arguments\./u,
		'should fail when it takes too many arguments.'
	);

	t.end();
});
