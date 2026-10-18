// Parvane fork: общие помощники рисования набора parvane_kit (только для parvane_kit*.cpp).
#pragma once

#include "parvane/parvane_kit.h"

#include <QtGui/QPainter>

namespace Parvane::Kit::internal {

// `filter: brightness(1.06)` — наведение на акцентные кнопки.
[[nodiscard]] QColor Brighter(QColor color);

// Значок ParvaneIcon; для `close` (его в наборе нет) — крест той же толщины линии.
void PaintIconOrFallback(QPainter &p, const QString &name, const QColor &color, int x, int y, int size);

// Базовая линия текста шрифта font, отцентрованного по вертикали в полосе [top, top + height).
[[nodiscard]] int Baseline(const style::font &font, int top, int height);

// Затемнение нажатой кнопки (в web нет `:active` — лёгкая подложка `--pv-fg` 8 %).
void PaintDownOverlay(QPainter &p, const QRectF &rect, double radius);

// Мягкая тень вокруг скруглённого прямоугольника: spread колец, общая непрозрачность alpha, сдвиг вниз dy.
void PaintSoftShadow(QPainter &p, const QRectF &rect, double radius, int spread, double alpha, int dy);

} // namespace Parvane::Kit::internal
