//! Упаковка прямоугольников полками (spec 040 T2): связные группы и одиночки занимают поле плотно и не
//! накладываются. Порядок — как передан (вызывающий сортирует сам).

/// Места левых верхних углов, ширина и высота занятого. Новая полка — когда очередной не входит в `width`.
pub(crate) fn shelves(sizes: &[(f64, f64)], width: f64, gap: f64) -> (Vec<(f64, f64)>, f64, f64) {
    let mut places = Vec::with_capacity(sizes.len());
    let (mut x, mut y, mut row_height, mut used_width) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for &(w, h) in sizes {
        if x > 0.0 && x + w > width {
            y += row_height + gap;
            x = 0.0;
            row_height = 0.0;
        }
        places.push((x, y));
        used_width = used_width.max(x + w);
        row_height = row_height.max(h);
        x += w + gap;
    }
    (places, used_width, y + row_height)
}

/// Ширина поля, при которой занятое близко к отношению сторон `aspect`: не уже самого широкого.
pub(crate) fn target_width(sizes: &[(f64, f64)], gap: f64, aspect: f64) -> f64 {
    let (mut area, mut widest) = (0.0f64, 0.0f64);
    for &(w, h) in sizes {
        area += (w + gap) * (h + gap);
        widest = widest.max(w);
    }
    widest.max((area * aspect).sqrt())
}
