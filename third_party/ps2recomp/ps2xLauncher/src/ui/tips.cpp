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

    // One table per page. CONTROLLER's is page_controller_tips.cpp; the other pages have none yet (issue #74 asked
    // for CONTROLLER first), and an empty table is the whole of what a page without lines costs.
    TipTable tipTable(Page page)
    {
        switch (page)
        {
        case Page::Controller: return controllerTips();
        default: return TipTable{};
        }
    }

    std::string tipFor(Page page, const std::string &id, const TipState &state)
    {
        if (id.empty())
            return std::string();
        const std::string line = lookUp(tipTable(page), id, state);
        if (!line.empty())
            return line;
        // The bottom bar's LAUNCH is on every page but PLAY; main.cpp draws it, so its line is the bar's own.
        if (id.rfind("bar.launch.", 0) == 0)
            return "LAUNCH: starts the game with these settings. Greyed until your disc image is verified.";
        return std::string();
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
