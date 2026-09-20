/**
 * @gis/shared —— GIS 系统共享包
 *
 * 服务端 / 编辑器 / 桌面端的跨包类型与服务端 client 统一从本包导入：
 * - types.ts：GeoJSON 类型、图层类型联合、PublishManifest、资产上传结果等
 * - scene.ts：SceneDocument 场景文档 schema
 * - api-client.ts：GIS 服务端 fetch client（GisApiClient）
 */

export * from './types.js';
export * from './scene.js';
export * from './api-client.js';
