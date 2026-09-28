import JSZip from 'jszip';
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { zipCacheBundle } from '../packages/xyz-cache/src/zip-bundle';

describe('zipCacheBundle', () => {
  it('按相对路径打包为 zip：entries 形式（不依赖 webkitdirectory）', async () => {
    const { zip: blob, fileCount, totalBytes } = await zipCacheBundle({
      rootDir: 'MyTiles',
      entries: [
        { path: 'tileset.json', data: JSON.stringify({ asset: { version: '1.0' } }) },
        { path: 'Tiles/0/0/0.b3dm', data: new Uint8Array([1, 2, 3, 4]) },
        { path: 'Tiles/1/0/0.b3dm', data: new Uint8Array([5, 6, 7, 8, 9, 10]) },
      ],
    });
    assert.ok(blob instanceof Blob);
    assert.strictEqual((fileCount), 3);
    assert.ok((totalBytes) > (0));

    // 验证 zip 内可被 JSZip 解回，路径符合预期
    const reader = new JSZip();
    const inner = await reader.loadAsync(await blob.arrayBuffer());
    const paths = Object.keys(inner.files);
    assert.ok((paths).includes('tileset.json'));
    assert.ok((paths).includes('Tiles/0/0/0.b3dm'));
    assert.ok((paths).includes('Tiles/1/0/0.b3dm'));

    const json = await inner.file('tileset.json')?.async('string');
    assert.strictEqual((JSON.parse(json ?? '{}').asset.version), '1.0');
  });

  it('File[] 形式：按 webkitRelativePath 去掉根目录段', async () => {
    const fakeFile = (rel: string, content: string): File => {
      const file = new File([content], rel.split('/').pop() ?? rel, { type: 'text/plain' });
      Object.defineProperty(file, 'webkitRelativePath', { value: rel, configurable: true });
      return file;
    };
    const files = [
      fakeFile('MyXYZ/0/0/0.png', 'png0'),
      fakeFile('MyXYZ/0/0/1.png', 'png1'),
      fakeFile('MyXYZ/1/0/0.png', 'png2'),
    ];
    const result = await zipCacheBundle(files);
    assert.strictEqual((result.fileCount), 3);
    assert.strictEqual((result.totalBytes), 12); // 'png0'/'png1'/'png2' 字节数

    const inner = await new JSZip().loadAsync(await result.zip.arrayBuffer());
    // 列出实际文件（排除 JSZip 自动生成的目录条目）
    const fileNames = Object.keys(inner.files)
      .filter((p) => !inner.files[p]!.dir)
      .sort();
    assert.deepStrictEqual((fileNames), ['0/0/0.png', '0/0/1.png', '1/0/0.png']);
  });

  it('不产生目录条目（回归 t15：服务端 zip 安全校验曾拒绝尾斜杠目录条目）', async () => {
    const { zip } = await zipCacheBundle({
      rootDir: 'MyTiles',
      entries: [
        { path: 'Tiles/tileset.json', data: '{}' },
        { path: 'Tiles/0/0/0.b3dm', data: new Uint8Array([1, 2, 3, 4]) },
      ],
    });
    const inner = await new JSZip().loadAsync(await zip.arrayBuffer());
    const all = Object.keys(inner.files);
    // JSZip 嵌套路径默认会生成 'Tiles/'、'Tiles/0/' 等目录条目（dir=true），
    // createFolders:false 后 zip 内应只剩文件条目
    assert.deepStrictEqual((all.filter((p) => inner.files[p]!.dir)), []);
    assert.deepStrictEqual(([...all].sort()), ['Tiles/0/0/0.b3dm', 'Tiles/tileset.json']);
  });

  it('STORE 压缩方式与字节大小一致', async () => {
    const { zip: storeZip, totalBytes } = await zipCacheBundle(
      {
        rootDir: 'X',
        entries: [{ path: 'a.txt', data: 'hello world' }],
      },
      { compressionMethod: 'STORE' },
    );
    // STORE 不压缩，文件数据至少 11 字节
    assert.strictEqual((totalBytes), 11);
    // zip header 会增加一些字节；总大小应大于 totalBytes 但合理
    assert.ok((storeZip.size) > (11));
  });

  it('空 entries 返回空 zip blob', async () => {
    const result = await zipCacheBundle({ rootDir: '', entries: [] });
    assert.strictEqual((result.fileCount), 0);
    assert.strictEqual((result.totalBytes), 0);
    assert.ok(result.zip instanceof Blob);
  });
});