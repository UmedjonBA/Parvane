package org.drinkless.tdlib

import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.tan

/**
 * spec 005 / MAP-1: геометрия статичной карты — порт `parvane-core/map_tiles.cpp
 * computeGeometry` (= web `renderStaticMap`): Web Mercator, тайл 256 px, зум по
 * умолчанию 16 (как web/desktop, не 13 как у TDLib), clamp зума [0,15] (P-23: шард
 * preview не отдаёт тайлы выше z15 — MAP-1 `maxZoom`), scale [1,3],
 * широты ±85.05; покрытие по floor, ty вне [0, 2^z) пропускается, x оборачивается;
 * dstX — по НЕобёрнутому tx. Тайлы — только через `preview.map.tile`.
 */
object MapGeometry {
    const val TILE = 256
    const val DEFAULT_ZOOM = 16
    const val MAX_ZOOM = 15
    private const val MAX_LAT = 85.05

    class Tile(val z: Int, val x: Int, val y: Int, val dstX: Int, val dstY: Int, val dstSize: Int) { val key get() = "$z/$x/$y" }
    class Geometry(val zoom: Int, val width: Int, val height: Int, val scale: Double, val centerX: Double, val centerY: Double,
                   val left: Double, val top: Double, val tiles: List<Tile>) {
        val canvasWidth get() = (width * scale).roundToInt()
        val canvasHeight get() = (height * scale).roundToInt()
    }

    fun compute(lat: Double, lon: Double, zoom: Int, width: Int, height: Int, scale: Double): Geometry {
        val z = min(MAX_ZOOM, max(0, zoom))
        val sc = min(3.0, max(1.0, scale))
        if (width <= 0 || height <= 0 || !lat.isFinite() || !lon.isFinite()) return Geometry(z, max(0, width), max(0, height), sc, 0.0, 0.0, 0.0, 0.0, emptyList())
        val n = Math.scalb(1.0, z)
        val latRad = max(-MAX_LAT, min(MAX_LAT, lat)) * PI / 180.0
        val centerX = ((lon + 180.0) / 360.0) * n * TILE
        val centerY = ((1.0 - ln(tan(latRad) + 1.0 / cos(latRad)) / PI) / 2.0) * n * TILE
        val left = centerX - width / 2.0
        val top = centerY - height / 2.0
        val ni = n.toLong()
        val txFrom = floor(left / TILE).toLong(); val txTo = floor((left + width) / TILE).toLong()
        val tyFrom = floor(top / TILE).toLong(); val tyTo = floor((top + height) / TILE).toLong()
        val dstSize = ceil(TILE * sc).toInt()
        val tiles = ArrayList<Tile>()
        for (tx in txFrom..txTo) for (ty in tyFrom..tyTo) {
            if (ty < 0 || ty >= ni) continue
            val wrapped = ((tx % ni) + ni) % ni
            tiles.add(Tile(z, wrapped.toInt(), ty.toInt(), Math.round((tx * TILE - left) * sc).toInt(), Math.round((ty * TILE - top) * sc).toInt(), dstSize))
        }
        return Geometry(z, width, height, sc, centerX, centerY, left, top, tiles)
    }

    /** Имя файла склеенной карты в media/ (кэш по параметрам). */
    fun fileName(lat: Double, lon: Double, zoom: Int, width: Int, height: Int, scale: Double): String =
        "map-%.5f_%.5f_%d_%dx%d@%d.png".format(java.util.Locale.ROOT, lat, lon, min(MAX_ZOOM, max(0, zoom)), width, height, min(3.0, max(1.0, scale)).roundToInt())
}
