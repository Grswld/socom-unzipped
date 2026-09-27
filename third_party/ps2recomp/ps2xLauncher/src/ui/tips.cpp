// Issue #74: the tooltip mechanism -- which page's table answers, the hover timer and where the box goes.
// The lines themselves are the pages' (tips.h).
#include "tips.h"

namespace ui
{
    namespace
    {
        bool matches(const TipRow &row, const std::string &id)
        {
            const std::string key = row.id;
            if (!key.empty() && key.back() == '.')
                return id.size() > key.size() && id.compare(0, key.size(), key) == 0;
            return id == key;
        }

        std::string lookUp(const TipTable &table, const std::string &id, const TipState &state)
        {
            for (std::size_t i = 0; i < table.count; ++i)
            {
                const TipRow &row = table.rows[i];
                if (matches(row, id))
                    return row.live != nullptr ? row.live(id, state) : std::string(row.text);
            }
            return std::string();
        }
    }

    TipTable tipTable(Page page)
    {
        (void)page;
        return TipTable{};
    }

    std::string tipFor(Page page, const std::string &id, const TipState &state)
    {
        if (id.empty())
            return std::string();
        return lookUp(tipTable(page), id, state);
    }

    void HoverTip::update(const std::string &over, double now)
    {
        if (over == id)
            return;
        id = over;
        since = now;
    }

    bool HoverTip::shows(double now) const
    {
        return !id.empty() && now - since >= kTipDelaySeconds;
    }

    std::string nodeAt(const std::vector<Node> &nodes, Vec2 at)
    {
        for (const Node &n : nodes)
            if (n.r.w > 0.0f && at.x >= n.r.x && at.x < n.r.right() && at.y >= n.r.y && at.y < n.r.bottom())
                return n.id;
        return std::string();
    }

    Rect tipBox(Rect control, float w, float h, Rect window)
    {
        const float gap = 6.0f;
        Rect box{control.x, control.bottom() + gap, w, h};
        if (box.bottom() > window.bottom())
            box.y = control.y - gap - h;
        if (box.right() > window.right())
            box.x = window.right() - w;
        if (box.x < window.x)
            box.x = window.x;
        if (box.y < window.y)
            box.y = window.y;
        return box;
    }
}
