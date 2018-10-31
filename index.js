'use strict';

const {createHash} = require('crypto');
const {inspect} = require('util');

const inspectWithKind = require('inspect-with-kind');
const isPlainObj = require('is-plain-obj');
const parseContentType = require('content-type').parse;
const Parse5SaxParser = require('parse5-sax-parser');

const TMP_HEADER_NAME = 'nodejs-temporary-inserted-header-name';
const PARSER_EVENTS = new Set(['startTag', 'endTag', 'comment', 'text', 'doctype']);
const CONTENT_LENGTH_ERROR = 'According to RFC7230, content-length header must be a non-negative integer https://tools.ietf.org/html/rfc7230#section-3.3.2';
const decoderOption = {fatal: true};
const incompleteDecodeOption = {stream: true};
const parserOption = {sourceCodeLocationInfo: true};
const utf8Re = /utf-?8/ui;

const push = Symbol('push');
const flush = Symbol('flush');
const internalWrite = Symbol('write');
const removeAnyTokenListeners = Symbol('removeAnyTokenListeners');
const onAnyToken = Symbol('onAnyToken');
const onTag = Symbol('onTag');

class HtmlInsertionStream extends Parse5SaxParser {
	constructor({targetTagName, insertionChunk, insertionLength, insertToEnd}) {
		super(parserOption);

		this.utf8Decoder = new TextDecoder('utf8', decoderOption); // eslint-disable-line no-undef
		this.buffers = [];
		this.stringBuffer = '';
		this.len = 0;
		this.writableOffset = 0;
		this.writtenOffset = 0;
		this.shouldParseHtml = false;
		this.targetTagName = targetTagName;
		this.insertionChunk = insertionChunk;
		this.insertToEnd = insertToEnd;
		this.insertionLength = insertionLength;
		this.insertionEventName = `${insertToEnd ? 'end' : 'start'}Tag`;

		for (const eventName of PARSER_EVENTS) {
			this.on(eventName, this[onAnyToken]);
		}

		this.on(this.insertionEventName, this[onTag]);
	}

	[push](data) {
		if (data.length === 0) {
			return null;
		}

		this.len += data.length;
		this.buffers.push(data);

		return data;
	}

	[internalWrite](data, encoding, isLast) {
		if (this.shouldParseHtml && encoding && typeof encoding !== 'function' && !utf8Re.test(encoding)) {
			const error = new Error(`HTML must be UTF-8 encoded https://github.com/w3c/html/pull/1273, but encoded in ${
				encoding
			}.`);
			error.code = 'ERR_INVALID_HTML_ENCODING';
			this.emit('error', error);

			return true;
		}

		if (!this[push](data)) {
			return true;
		}

		let str;

		try {
			str = isLast ?
				this.utf8Decoder.decode(Uint8Array.from(data)) :
				this.utf8Decoder.decode(Uint8Array.from(data), incompleteDecodeOption);
		} catch (err) {
			err.message = 'The HTML cannot be encoded to a valid UTF-8 character sequence.';
			this.emit('error', err);
		}

		this.stringBuffer += str;
		return super.write(str);
	}

	write(data, encoding) {
		return this[internalWrite](data, encoding, false);
	}

	writeLast(data, encoding) {
		return this[internalWrite](data, encoding, true);
	}

	[flush]() {
		if (this.buffers.length === 1) {
			return this.buffers.pop();
		}

		return Buffer.concat(this.buffers.splice(0), this.len);
	}

	[onAnyToken]({sourceCodeLocation: {endOffset}}) {
		this.writableOffset = Buffer.byteLength(this.stringBuffer.substring(0, endOffset));
	}

	[removeAnyTokenListeners]() {
		for (const eventName of PARSER_EVENTS) {
			this.off(eventName, this[onAnyToken]);
		}
	}

	[onTag]({tagName, sourceCodeLocation: {startOffset, endOffset}}) {
		if (tagName !== this.targetTagName) {
			return;
		}

		this[removeAnyTokenListeners]();
		this.off(this.insertionEventName, this[onTag]);
		this.stop();
		this.shouldParseHtml = false;

		const insertionIndex = Buffer.byteLength(this.stringBuffer.substring(
			0,
			this.insertToEnd ? startOffset : endOffset
		)) - this.writtenOffset;
		let index = 0;

		for (const [arrIndex, buffer] of this.buffers.entries()) {
			if (index + buffer.length >= insertionIndex) {
				const sliceIndex = insertionIndex - index;

				this.buffers.splice(
					arrIndex,
					1,
					buffer.slice(0, sliceIndex),
					this.insertionChunk,
					buffer.slice(sliceIndex)
				);

				break;
			}

			index += buffer.length;
		}

		this.len += this.insertionLength;

		this.end();
	}

	getWritableBuffer() {
		if (this.writableOffset !== 0) {
			const writableLen = this.writableOffset - this.writtenOffset;
			let index = 0;

			this.writtenOffset = this.writableOffset;
			this.writableOffset = 0;
			this.len -= writableLen;

			for (const [arrIndex, buffer] of this.buffers.entries()) {
				if (index + buffer.length === writableLen) {
					return Buffer.concat(this.buffers.splice(0, arrIndex + 1), writableLen);
				}

				if (index + buffer.length > writableLen) {
					const sliceIndex = writableLen - index;
					const writingBuffers = this.buffers.splice(0, arrIndex + 1, buffer.slice(sliceIndex));

					writingBuffers.splice(-1, 1, buffer.slice(0, sliceIndex));
					return Buffer.concat(writingBuffers, writableLen);
				}

				index += buffer.length;
			}
		}

		return Buffer.alloc(0);
	}
}

function ensureResponseSetHeaderWorks(res) {
	if (res === null || typeof res !== 'object' || typeof res.setHeader !== 'function') {
		const error = new TypeError(`Expected a ServerResponse object, but got ${inspectWithKind(res)}.`);

		error.code = 'ERR_INVALID_ARG_TYPE';
		Error.captureStackTrace(ensureResponseSetHeaderWorks);

		throw error;
	}

	// ref. https://nodejs.org/api/http.html#http_response_writehead_statuscode_statusmessage_headers
	// If this method is called and `response.setHeader()` has not been called,
	// it will directly write the supplied header values onto the network channel without caching internally,
	// and the `response.getHeader()` on the header will not yield the expected result.
	// If progressive population of headers is desired with potential future retrieval and modification,
	// use `response.setHeader()` instead.

	try {
		res.setHeader(TMP_HEADER_NAME, '1');
		res.removeHeader(TMP_HEADER_NAME);
	} catch {}
}

function hasHtmlContentType(res) {
	const contentTypeHeader = res.getHeader('content-type');

	try {
		return parseContentType(contentTypeHeader).type === 'text/html';
	} catch ({message}) {
		const error = new TypeError(`${inspect(contentTypeHeader)} is not a valid value for content-type header: ${
			message
		}.`);

		Error.captureStackTrace(error, hasHtmlContentType);
		res.emit('error', error);
	}

	return false;
}

function main(res, insertionChunk, insertionLength, etag, targetTagName, insertToEnd) { // eslint-disable-line max-params
	if (res.headersSent) {
		return;
	}

	ensureResponseSetHeaderWorks(res);

	const originalWrite = res.write.bind(res);
	const originalEnd = res.end.bind(res);
	const originalSetHeader = res.setHeader.bind(res);

	const parser = new HtmlInsertionStream({targetTagName, insertionChunk, insertionLength, insertToEnd})
	.on('error', err => res.emit('error', err));

	function restoreOriginalMethods() {
		res.setHeader = originalSetHeader;
		res.write = originalWrite;
		res.end = originalEnd;
	}

	res.prependListener('error', restoreOriginalMethods);

	function adjustContentLength(originalContentLengthHeaderValue) {
		let originalContentLength;

		if (typeof originalContentLengthHeaderValue === 'number') {
			originalContentLength = originalContentLengthHeaderValue;

			if (!Number.isInteger(originalContentLength) || originalContentLength < 0) {
				res.removeHeader('content-length');
				res.emit('error', new Error(`${CONTENT_LENGTH_ERROR}, but it was ${
					inspect(originalContentLengthHeaderValue)
				}.`));

				return;
			}
		} else {
			originalContentLength = parseInt(originalContentLengthHeaderValue, 10);
			if (/\D/u.test(`${originalContentLengthHeaderValue}`)) {
				res.removeHeader('content-length');
				res.emit('error', new Error(`${CONTENT_LENGTH_ERROR}, but it was ${
					inspect(originalContentLengthHeaderValue)
				}.`));

				return;
			}
		}

		if (parser.shouldParseHtml && res.getHeader('content-length') !== originalContentLength + insertionLength) {
			originalSetHeader('content-length', `${originalContentLength + insertionLength}`);
		}
	}

	function updateHeaders() {
		if (res.hasHeader('content-type')) {
			parser.shouldParseHtml = hasHtmlContentType(res);
		}

		if (res.hasHeader('content-length')) {
			adjustContentLength(res.getHeader('content-length'));
		}

		if (etag.length !== 0 && parser.shouldParseHtml && res.hasHeader('etag')) {
			originalSetHeader('etag', `${res.getHeader('etag')}${etag}`);
			etag = '';
		}
	}

	updateHeaders();

	res.setHeader = (headerName, ...restArgs) => {
		originalSetHeader(headerName, ...restArgs);
		updateHeaders(headerName);
	};

	// No need to patch `res.writeHead()` here because it calls `res.setHeader()` internally
	// https://github.com/nodejs/node/blob/v10.12.0/lib/_http_server.js#L231

	function write(data, ...restArgs) {
		const [encoding] = restArgs;

		if (!Buffer.isBuffer(data)) {
			data = Buffer.from(data);
		}

		if (parser.shouldParseHtml) {
			parser.write(data, encoding);

			const writableBuffer = parser.getWritableBuffer();

			if (writableBuffer.length !== 0) {
				originalWrite(writableBuffer);
			}

			if (typeof restArgs[restArgs.length - 1] === 'function') {
				restArgs[restArgs.length - 1]();
			}

			return true;
		}

		restoreOriginalMethods();

		return originalWrite(
			Buffer.concat([...parser.buffers.splice(0), data], parser.len + data.length),
			...restArgs
		);
	}

	res.write = (...args) => {
		res.setHeader = originalSetHeader;

		if (!res.headersSent) {
			res.writeHead(res.statusCode);
		}

		if (!parser.shouldParseHtml) {
			res.write = originalWrite;
			res.end = originalEnd;
			parser.destroy();

			return originalWrite(...args);
		}

		res.write = write;
		return write(...args);
	};

	res.end = (...args) => {
		restoreOriginalMethods();
		parser[removeAnyTokenListeners]();

		if (parser.buffers.length === 0 && !parser.shouldParseHtml) {
			parser.destroy();
			return originalEnd(...args);
		}

		if (args.length === 0 || typeof args[0] === 'function') {
			args.unshift(Buffer.alloc(0));
		} else if (!Buffer.isBuffer(args[0])) {
			args[0] = Buffer.from(args[0]);
		}

		const [data, ...restArgs] = args;

		if (parser.shouldParseHtml) {
			parser.writeLast(data, restArgs[0]);
		} else {
			parser[push](data);
		}

		const flushed = originalEnd(parser[flush](), ...restArgs);

		parser.destroy();
		return flushed;
	};
}

function md5Base64(str) {
	return createHash('md5').update(str).digest('base64');
}

function convertInsertionChunkStringToBuffer(str) {
	if (typeof str !== 'string') {
		const error = new TypeError(`Expected a <string> to inject into HTML as the last child of \`head\` tag, but got a non-string value ${
			inspectWithKind(str)
		}.`);

		error.code = 'ERR_INVALID_ARG_TYPE';
		Error.captureStackTrace(error, convertInsertionChunkStringToBuffer);

		throw error;
	}

	return Buffer.from(str);
}

const TAG_NAME_ERROR = 'Expected `tagName` option to be an HTML tag name';
const noOptionsProvided = Symbol('noOptionsProvided');

function prepareOptionArguments(options) {
	if (options === noOptionsProvided) {
		return ['body', false];
	}

	if (!isPlainObj(options)) {
		const error = new TypeError(`Expected an <Object> to set inject-html-content options, but got ${
			inspectWithKind(options)
		}.`);
		error.code = 'ERR_INVALID_ARG_TYPE';
		Error.captureStackTrace(error, prepareOptionArguments);

		throw error;
	}

	const {tagName, insertToEnd} = options;

	if (tagName !== undefined) {
		let error;

		if (typeof tagName !== 'string') {
			error = new TypeError(`${TAG_NAME_ERROR} (<string>), but got a non-string value ${
				inspectWithKind(tagName)
			}.`);
		} else if (tagName.length === 0) {
			error = Error(`${TAG_NAME_ERROR}, but got '' (empty string).`);
		} else if (tagName.trim().length === 0) {
			error = Error(`${TAG_NAME_ERROR}, but got a whitespace-only string ${inspect(tagName)}.`);
		} else if (tagName.match(/\s/u) !== null) {
			error = Error(`${TAG_NAME_ERROR}, but got an invalid tag name ${inspect(tagName)}.`);
		}

		if (error) {
			error.code = 'ERR_INVALID_OPTION_VALUE';
			Error.captureStackTrace(error, prepareOptionArguments);

			throw error;
		}
	}

	if (insertToEnd !== undefined && typeof insertToEnd !== 'boolean') {
		const error = new TypeError(`Expected \`insertToEnd\` option to be a boolean, but got a non-boolean value ${
			inspectWithKind(insertToEnd)
		}.`);

		error.code = 'ERR_INVALID_OPTION_VALUE';
		Error.captureStackTrace(error, prepareOptionArguments);

		throw error;
	}

	return [tagName ? tagName.toLowerCase() : 'body', insertToEnd || false];
}

module.exports = function insertHtmlContent(...args) {
	const argLen = args.length;

	if (argLen !== 2 && argLen !== 3) {
		throw new RangeError(`Expected 2 or 3 arguments (<http.ServerResponse>, <string>[, <Object>]), but got ${
			argLen === 0 ? 'no' : argLen
		} arguments.`);
	}

	const [res, insertionChunk, options = noOptionsProvided] = args;
	const buffer = convertInsertionChunkStringToBuffer(insertionChunk);

	main(res, buffer, buffer.length, md5Base64(buffer), ...prepareOptionArguments(options));
};

function insertHtmlContentFromClass(...args) {
	const argLen = args.length - 5;

	if (argLen !== 1) {
		throw new RangeError(`Expected 1 argument (<http.ServerResponse>), but got ${
			argLen === 0 ? 'no' : argLen
		} arguments.`);
	}

	main(args[5], args[0], args[1], args[2], args[3], args[4]);
}

module.exports.InsertHtmlContent = class InsertHtmlContent {
	constructor(...args) {
		const argLen = args.length;

		if (argLen !== 1 && argLen !== 2) {
			throw new RangeError(`Expected 1 or 2 arguments (<string>[, <Object>]), but got ${
				argLen === 0 ? 'no' : argLen
			} arguments.`);
		}

		const [insertionChunk, options = noOptionsProvided] = args;
		const buffer = convertInsertionChunkStringToBuffer(insertionChunk);

		return insertHtmlContentFromClass.bind(
			null,
			buffer,
			buffer.length,
			md5Base64(buffer),
			...prepareOptionArguments(options)
		);
	}
};
