// Parvane fork: линейные значки оболочки «Пространство» (как web ParvaneIcon): контуры одной толщины цветом
// текста — рейка разделов, шапки разделов, плитки. Значки мессенджера остаются штатными иконками tdesktop.
#pragma once

#include <QtGui/QColor>
#include <QtGui/QImage>

class QPainter;

namespace Parvane {

// Имена — как в web (`chat`, `calendar`, `heart`, `book`, `cloud`, `search`, `user`, `plus`, `pen`, …).
[[nodiscard]] bool HasIcon(const QString &name);

// Значок size×size логических пикселей (обычный — 22, мелкий — 18) цветом color; кэшируется.
[[nodiscard]] QImage IconImage(const QString &name, const QColor &color, int size);

// Нарисовать значок с левым верхним углом в (x, y).
void PaintIcon(QPainter &p, const QString &name, const QColor &color, int x, int y, int size);

} // namespace Parvane
