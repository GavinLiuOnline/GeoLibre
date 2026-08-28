# 3D Tiles pipeline

The **3D Tiles Pipeline** plugin is a SuperMap-style workbench for taking a local 3D dataset through geographic registration and onto the map as [OGC 3D Tiles](https://www.ogc.org/standards/3DTiles/). Activate it from **Plugins → 3D Tiles Pipeline**, or open it from the **3D Tiles** toolbar menu the plugin registers.

It is an authoring path. To *view* an existing tileset URL, use **Add Data → 3D Tiles Layer** instead.

## Workflow

The right sidebar walks four steps. Import adds a layer to the current project immediately; later steps update that layer.

1. **Import** — choose a file or a **folder**. A mesh, point cloud, or 3D Tiles tree is added as a layer (no separate preview step). Oblique photography folders that already contain `tileset.json` load as a 3D Tiles layer. ContextCapture `metadata.xml` (and Bentley `.3mx`) is read for the site CRS.
2. **Register** — pin the dataset to the ellipsoid. **Coordinate system** converts local Cartesian metres (CAD / RTK handheld, typically CGCS2000, Beijing 1954, or WGS84 Gauss-Kruger / UTM, with zone and false origin) to longitude / latitude. **Ground control** pairs model XYZ with lon/lat/height (one point sets the origin; three or more fit a 3D similarity). Heading, pitch, roll, scale, and **click map for origin** are the same registration, not a separate positioning step.
3. **Optimize** — optional vertex welding, a keep-fraction for thinning, 1–6 REPLACE LOD levels, and 16-bit position quantization. Mesh layers on the map refresh when these change.
4. **Export** — download a `tileset.zip` (`tileset.json` + `tiles/lod*.glb` or `.pnts`), or **Add as 3D Tiles layer** so the 3D Tiles renderer loads the optimized result. A QA report (counts, geographic bounds, GCP residual, per-LOD geometric error) sits on this step.

The root tile's `transform` is an east-north-up frame at the origin, so Cesium (the 3D globe pane) and MapLibre 3D Tiles both land the dataset on the ellipsoid.

## Formats

| Input | Output content | Notes |
| --- | --- | --- |
| GLB | `.glb` (3D Tiles 1.1 glTF) | Materials/textures are kept on a transform-only export (reduction 100%, one LOD level). Re-encoded LOD children are untextured geometry. |
| glTF + `.bin` | `.glb` | Import the folder (or both files) so the external buffer resolves. |
| OBJ | `.glb` | Positions only; triangulated n-gons. Treated as Z-up. |
| STL / PLY | `.glb` | ASCII or binary STL; ASCII or little-endian PLY. |
| LAS 1.2 / 1.4 | `.pnts` | Uncompressed only. RGB is stored when the point format carries it. |
| 3D Tiles folder (`tileset.json`) | same tree | Typical oblique-photogrammetry delivery. Added as a 3D Tiles layer; export re-zips the files. |
| OSGB / oblique folder (`metadata.xml`) | CRS + mesh/tileset | `metadata.xml` / `.3mx` supplies `ENU:lat,lng` or `EPSG:…` plus `SRSOrigin`. Raw `.osgb` geometry is not decoded; include `tileset.json` or an OBJ/GLB export from the same project. |

On the desktop sidecar, `POST /tiles3d/las-to-3dtiles` converts a LAS path to the same zip layout for batch jobs (confined to `GEOLIBRE_CONVERSION_ROOTS` like other conversion endpoints). Interactive mesh work stays in the plugin.

## Local CRS (engineering / RTK)

Drawings and RTK handhelds usually store easting / northing in metres. Fill in:

- **proj4 / EPSG** — paste a proj4 string (for example `+proj=aea +lat_1=25 +lat_2=47 +lat_0=0 +lon_0=105 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs`) or `EPSG:32650`. Every `+key=value` token is shown as its own field and filled from the string. UTM, Web Mercator, Gauss-Kruger, and China Albers also set the CRS dropdown.
- **Zone** and whether the easting **includes the zone prefix** (`带号`, `zone × 1e6 + 500000`)
- **Origin X/Y/Z** — projected metres of the *site* / model `(0,0,0)` (RTK station or CAD false origin). These are not the same as proj4 `+x_0` / `+y_0` (false easting of the CRS).
- **Model XY are already projected metres** — when vertices are absolute grid coordinates, they are recentred on the bounding-box centre before placement

**Apply coordinate system** writes WGS84 longitude / latitude / height. The live layer moves with that result.

## After export

Serve the unzipped folder over HTTP (or keep the blob URLs **Add as 3D Tiles layer** already registered) and reopen it with **Add Data → 3D Tiles Layer**. **Project → Export Cesium cockpit...** can also package the current map's online layers plus cached local GeoJSON / 3D Tiles into a titled digital-twin HUD (`index.html` framing `globe.html` + `config.js`). Saved projects persist plugin placement/CRS/GCP settings; the imported binary is not stored in `.geolibre.json`.
