# insert-html-content

[![npm version](https://img.shields.io/npm/v/insert-html-content.svg)](https://www.npmjs.com/package/insert-html-content)
[![GitHub Actions](https://action-badges.now.sh/shinnn/insert-html-content)](https://wdp9fww0r9.execute-api.us-west-2.amazonaws.com/production/results/shinnn/insert-html-content)
[![codecov](https://codecov.io/gh/shinnn/insert-html-content/branch/master/graph/badge.svg)](https://codecov.io/gh/shinnn/insert-html-content)

Insert contents into an HTML of a response body

```javascript
const {createServer} = require('http');
const fetch = require('node-fetch');
const insertHtmlContent = require('insert-html-content');

createServer((req, res) => {
  insertHtmlContent(res, 'Hello ');

  res.setHeader('content-type', 'text/html');
  res.end('<html><body>World</body></html>');
}).listen(3000, async () => {
  await (await fetch('http://localhost:3000')).text(); //=> '<html><body>Hello, World</body></html>'
});
```

## Installation

[Use](https://docs.npmjs.com/cli/install) [npm](https://docs.npmjs.com/about-npm/).

```
npm install insert-html-content
```

## API

```javascript
const insertHtmlContent = require('insert-html-content');
```

### insertHtmlContent(*response*, *content* [, *options*])

*response*: [`http.ServerResponse`](https://nodejs.org/api/http.html#http_class_http_serverresponse)  
*content*: `string`  
*options*: `Object`

If the media type of the response is `text/html`, it inserts a given content into the response body as the first child of `<body>` tag once, with increasing the value of `content-length` header if necessary.

```javascript
const {createServer} = require('http');
const fetch = require('node-fetch');
const injectBody = require('insert-html-content');

const html = Buffer.from('<html><body><h2>Hi</h2></body></html>');
const inserted = '<h1>🏄‍</h1>';

createServer((req, res) => {
  insertHtmlContent(res, inserted);

  res.setHeader('content-type', 'text/html');
  res.setHeader('content-length', 37/* html.length */);
  res.end(html);
}).listen(3000, async () => {
  const response = await fetch('http://localhost:3000');

  Number(response.headers.get('content-length'));
  //=> 53, html.length + Buffer.byteLength(inserted)

  await response.text(); //=> '<html><body><h1>🏄‍</h1><h2>Hi</h2></body></html>'
});
```

If the media type is not `text/html`, or the response body has no `<body>` tag, it does nothing.

### options.tagName

Type: `string`  
Default: `'body'`

Change the insertion target to the given tag.

```javascript
createServer((req, res) => {
  insertHtmlContent(res, '<script src="inserted.js"></script>', {
    tagName: 'head'
  });

  res.setHeader('content-type', 'text/html');
  res.end('<html><head></head></html>');
}).listen(3000, async () => {
  await (await fetch('http://localhost:3000')).text(); //=> '<html><head><script src="inserted.js"></script></head></html>'
});
```

### options.insertToEnd

Type: `boolean`  
Default: `false`

When this option is `true`, it inserts a content to the last child of the target tag instead.

Default:

```html
<body><div>existing content</div><div>inserted content</div></body>
```

`insertToEnd: true`:

```html
<body><div>inserted content</div><div>existing content</div></body>
```

### class insertHtmlContent.InsertHtmlContent(*contents* [, *options*])

*content*: `string`  
*options*: `Object`  
Return: `Function`

Create a new `insertHtmlContent` function with the fixed `content` and `options`. Use this class if a server will insert the same contents into every HTML response many times.

```javascript
const {InsertHtmlContent} = require('insert-html-content');

const injectStyle = new InsertHtmlContent('<style>body {color: red}</style>');
```

## License

[ISC License](./LICENSE) © 2018 - 2019 Watanabe Shinnosuke
