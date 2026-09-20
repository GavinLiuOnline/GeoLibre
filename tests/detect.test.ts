import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  detectCacheKind,
  detectTileset,
  detectXyzTiles,
  fileUrlToPath,
  findByBasename,
  flattenDirectoryFiles,
  hasUrlScheme,
  isFileUrl,
  isLoadableTileUrl,
  levelRangeOfKeys,
  normalizeRelativePath,
  parseXyzPath,
  urlProtocolOf,
  xyzKeyFromUrl,
} from '../packages/xyz-cache/src/detect';
import type { FlattenedFile } from '../packages/xyz-cache/src/detect';

const fakeFile = (rel: string, size = 0): File => {
  const file = new File([new Uint8Array(size)], rel.split('/').pop() ?? rel, { type: 'application/octet-stream' });
  Object.defineProperty(file, 'webkitRelativePath', { value: rel, configurable: true });
  return file;
};

describe('normalizeRelativePath', () => {
  it('统一分隔符 + 去除 ./ 头部 + 去除尾部 /', () => {
    assert.strictEqual(normalizeRelativePath('./a\\b/c\\'), 'a/b/c');
    assert.strictEqual(normalizeRelativePath('plain/path'), 'plain/path');
    assert.strictEqual(normalizeRelativePath(''), '');
  });
});

describe('flattenDirectoryFiles', () => {
  it('按 webkitRelativePath 拆 rootDir + relPath', () => {
    const items = flattenDirectoryFiles([
      fakeFile('MyDir/tileset.json', 10),
      fakeFile('MyDir/Tiles/0/0/0.b3dm', 20),
    ]);
    assert.strictEqual(items.length, (2));
    assert.strictEqual(items[0].rootDir, 'MyDir');
    assert.strictEqual(items[0].relPath, 'tileset.json');
    assert.strictEqual(items[0].size, 10);
    assert.strictEqual(items[1].relPath, 'Tiles/0/0/0.b3dm');
  });

  it('忽略没有 webkitRelativePath 的文件（webkitdirectory 模式必有）', () => {
    const items = flattenDirectoryFiles([fakeFile('foo.txt', 5)]);
    assert.deepStrictEqual(items, []);
  });
});

describe('parseXyzPath & detectXyzTiles', () => {
  it('parseXyzPath 识别合法 XYZ 瓦片路径', () => {
    assert.deepStrictEqual(parseXyzPath('0/0/0.png'), { level: 0, x: 0, y: 0, ext: 'png' });
    assert.deepStrictEqual(parseXyzPath('14/16800/12500.jpg'), { level: 14, x: 16800, y: 12500, ext: 'jpg' });
    assert.deepStrictEqual(parseXyzPath('Tiles/5/10/12.webp'), { level: 5, x: 10, y: 12, ext: 'webp' });
  });

  it('parseXyzPath 拒绝非法路径', () => {
    assert.strictEqual(parseXyzPath('5/10/12'), null); // 缺扩展名
    assert.strictEqual(parseXyzPath('5/10/abc.png'), null); // y 非数字
    assert.strictEqual(parseXyzPath('not-yaml.txt'), null);
  });

  it('detectXyzTiles: 同 ext 占比 >= 80% 才视为瓦片目录', () => {
    const png = flattenDirectoryFiles([
      fakeFile('Tiles/0/0/0.png'),
      fakeFile('Tiles/0/0/1.png'),
      fakeFile('Tiles/1/0/0.png'),
    ]);
    const det = detectXyzTiles(png);
    assert.notStrictEqual(det, undefined);
    assert.strictEqual(det?.template, '{z}/{x}/{y}.png');
    assert.strictEqual(det?.minLevel, 0);
    assert.strictEqual(det?.maxLevel, 1);
    assert.strictEqual(det?.tileCount, 3);
  });

  it('detectXyzTiles: 混 png/jpg 时不识别', () => {
    const mixed = flattenDirectoryFiles([
      fakeFile('0/0/0.png'),
      fakeFile('0/0/1.jpg'),
      fakeFile('0/0/2.png'),
      fakeFile('0/0/3.png'),
    ]);
    assert.strictEqual(detectXyzTiles(mixed), undefined);
  });
});

describe('detectTileset & findByBasename', () => {
  it('findByBasename 按基名匹配，按路径最短优先', () => {
    const items = flattenDirectoryFiles([
      fakeFile('Cache/sub/tileset.json'),
      fakeFile('Cache/tileset.json'),
    ]);
    const hits = findByBasename(items, ['tileset.json']);
    // relPath 已剥掉 rootDir；按 relPath 长度升序，根层 'tileset.json' 最短优先
    assert.strictEqual(hits[0].path, 'tileset.json');
    assert.strictEqual(hits[1].path, 'sub/tileset.json');
  });

  it('detectTileset 命中 tileset.json', () => {
    const items = flattenDirectoryFiles([
      fakeFile('Cache/tileset.json'),
      fakeFile('Cache/Tiles/0/0/0.b3dm'),
    ]);
    assert.strictEqual(detectTileset(items)?.path, 'tileset.json');
  });

  it('没有 tileset.json 时返回 undefined', () => {
    const items = flattenDirectoryFiles([fakeFile('Cache/foo.txt')]);
    assert.strictEqual(detectTileset(items), undefined);
  });
});

describe('detectCacheKind 优先级', () => {
  it('优先 3dtiles（同时含 tileset.json 与 XYZ 瓦片时）', () => {
    const items = flattenDirectoryFiles([
      fakeFile('Cache/tileset.json'),
      fakeFile('Cache/0/0/0.png'),
    ]);
    const det = detectCacheKind(items);
    assert.strictEqual(det?.kind, '3dtiles');
  });

  it('仅有 XYZ 瓦片时返回 xyz', () => {
    const items = flattenDirectoryFiles([
      fakeFile('Cache/0/0/0.png'),
      fakeFile('Cache/1/0/0.png'),
    ]);
    const det = detectCacheKind(items);
    assert.strictEqual(det?.kind, 'xyz');
  });

  it('都没有时返回 null', () => {
    const items = flattenDirectoryFiles([fakeFile('Cache/readme.txt')]);
    assert.strictEqual(detectCacheKind(items), null);
  });
});
// ---------------------------------------------------------------------------
// t18：file:// / URL 探测与超大目录探测
// ---------------------------------------------------------------------------

describe('t18 · URL / 本地路径识别', () => {
  it('urlProtocolOf / hasUrlScheme：识别 scheme，但不误判 Windows 盘符', () => {
    assert.strictEqual(urlProtocolOf('file:///home/x'), 'file:');
    assert.strictEqual(urlProtocolOf('HTTP://EXAMPLE.COM/a.png'), 'http:');
    assert.strictEqual(urlProtocolOf('blob:http://x/y'), 'blob:');
    assert.strictEqual(urlProtocolOf('C:/tiles/0/0/0.png'), null); // 单字符盘符不是 scheme
    assert.strictEqual(urlProtocolOf('0/0/0.png'), null);
    assert.strictEqual(urlProtocolOf('./a/b.png'), null);

    assert.strictEqual(hasUrlScheme('file:///home/x'), true);
    assert.strictEqual(hasUrlScheme('C:\\tiles\\0\\0\\0.png'), false);
    assert.strictEqual(hasUrlScheme('tiles/0/0/0.png'), false);
  });

  it('isFileUrl + fileUrlToPath：file:// → 本地路径（含 host 形式与非法转义）', () => {
    assert.strictEqual(isFileUrl('file:///home/nuanyang/tiles'), true);
    assert.strictEqual(isFileUrl('/home/nuanyang/tiles'), false);

    assert.strictEqual(fileUrlToPath('file:///home/nuanyang/tiles'), '/home/nuanyang/tiles');
    assert.strictEqual(fileUrlToPath('file:///home/nuan%20yang/tiles'), '/home/nuan yang/tiles');
    assert.strictEqual(fileUrlToPath('file://server/share/x'), '//server/share/x');
    assert.throws(() => fileUrlToPath('/home/nuanyang/tiles'), /不是 file:\/\/ URL/);
    assert.throws(() => fileUrlToPath('file:///bad%zz'), /无法解析 file:\/\/ URL/);
  });

  it('isLoadableTileUrl：blob/data/http(s)/相对路径可加载；file: 等不可加载', () => {
    assert.strictEqual(isLoadableTileUrl('blob:http://x/1'), true);
    assert.strictEqual(isLoadableTileUrl('data:image/png;base64,AA'), true);
    assert.strictEqual(isLoadableTileUrl('https://cdn/x.png'), true);
    assert.strictEqual(isLoadableTileUrl('0/0/0.png'), true);
    assert.strictEqual(isLoadableTileUrl('file:///home/nuanyang/tiles/0/0/0.jpg'), false);
    assert.strictEqual(isLoadableTileUrl('ftp://host/0/0/0.jpg'), false);
  });

  it('xyzKeyFromUrl：从裸路径与绝对 URL 都能取到 {z}/{x}/{y} 键', () => {
    assert.strictEqual(xyzKeyFromUrl('0/0/0.jpg'), '0/0/0');
    assert.strictEqual(xyzKeyFromUrl('tiles/14/16800/12500.jpg'), '14/16800/12500');
    assert.strictEqual(xyzKeyFromUrl('file:///home/nuanyang/tiles/12/3427/1565.jpg'), '12/3427/1565');
    assert.strictEqual(xyzKeyFromUrl('https://cdn/tiles/5/10/12.png?v=2'), '5/10/12');
    assert.strictEqual(xyzKeyFromUrl('https://cdn/tileset.json'), undefined);
    assert.strictEqual(xyzKeyFromUrl(''), undefined);
  });

  it('levelRangeOfKeys：层级范围（空集合回退 0..0）', () => {
    assert.deepStrictEqual(levelRangeOfKeys(['0/0/0', '12/1/1', '9/2/2']), { min: 0, max: 12 });
    assert.deepStrictEqual(levelRangeOfKeys([]), { min: 0, max: 0 });
  });
});

describe('t18 · detect 对 file:// 输入的处理', () => {
  it('parseXyzPath 拒绝带 scheme 的字符串（file:// / http://），仍接受盘符路径', () => {
    assert.strictEqual(parseXyzPath('file:///home/nuanyang/tiles/0/0/0.jpg'), null);
    assert.strictEqual(parseXyzPath('https://cdn/tiles/1/2/3.png'), null);
    assert.strictEqual(parseXyzPath('blob:http://x/1'), null);
    // 相对路径 / 盘符路径不变
    assert.deepStrictEqual(parseXyzPath('0/0/0.jpg'), { level: 0, x: 0, y: 0, ext: 'jpg' });
    assert.deepStrictEqual(parseXyzPath('C:/tiles/1/2/3.png'), { level: 1, x: 2, y: 3, ext: 'png' });
  });

  it('detectXyzTiles 不会把 file:// 路径当成瓦片目录（需走清单/目录选择）', () => {
    const items: FlattenedFile[] = [
      { rootDir: 'tiles', relPath: 'file:///home/nuanyang/tiles/0/0/0.jpg', size: 1, file: undefined as unknown as File },
      { rootDir: 'tiles', relPath: 'file:///home/nuanyang/tiles/1/0/0.jpg', size: 1, file: undefined as unknown as File },
    ];
    assert.strictEqual(detectXyzTiles(items), undefined);
    assert.strictEqual(detectCacheKind(items), null);
  });

  it('超大目录（15 万条）探测不再抛 RangeError（原 Math.min(...levels) 会栈溢出）', () => {
    const items: FlattenedFile[] = [];
    for (let z = 0; z < 15 && items.length < 150_000; z++) {
      for (let x = 0; x < 10_000 && items.length < 150_000; x++) {
        items.push({
          rootDir: 'tiles',
          relPath: `${z}/${x}/0.jpg`,
          size: 1,
          file: undefined as unknown as File,
        });
      }
    }
    assert.strictEqual(items.length, (150_000));
    const detection = detectXyzTiles(items);
    assert.strictEqual(detection?.ext, 'jpg');
    assert.strictEqual(detection?.minLevel, 0);
    assert.strictEqual(detection?.maxLevel, 14);
    assert.strictEqual(detection?.tileCount, 150_000);
  });
});
