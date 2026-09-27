// Issue #74: the tooltip mechanism -- which page's table answers, the hover timer and where the box goes.
// The lines themselves are the pages' (tips.h).
#include "tips.h"

#include "theme.h"

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

    Rect footerTipSlot(const Frame &frame)
    {
        // main.cpp's drawBottomBar: the status column starts 130 past the margin (after PROFILE), and the prompts
        // take the 330 before LAUNCH (220 wide, one margin in from the right edge); 24 of air before the prompts.
        const float x = metrics::margin + 130.0f;
        const float prompts = frame.bar.right() - metrics::margin - 220.0f - 330.0f;
        return Rect{x, frame.bar.y, prompts - x - 24.0f, frame.bar.h};
    }

    std::vector<std::string> wrapWords(const std::string &s, float maxWidth, const std::function<float(const std::string &)> &width)
    {
        std::vector<std::string> lines;
        std::string line;
        size_t at = 0;
        while (at < s.size())
        {
            size_t end = at;
            while (end < s.size() && s[end] != ' ')
                ++end;
            while (end < s.size() && s[end] == ' ')
                ++end;
            const std::string word = s.substr(at, end - at);
            at = end;
            if (!line.empty() && width(line + word) > maxWidth)
            {
                lines.push_back(line);
                line.clear();
            }
            line += word;
        }
        if (!line.empty())
            lines.push_back(line);
        for (std::string &l : lines)
            while (!l.empty() && l.back() == ' ')
                l.pop_back();
        return lines;
    }

    void StatusWatch::update(const std::string &status, double now)
    {
        if (status == seen)
            return;
        seen = status;
        since = now;
    }

    bool StatusWatch::fresh(double now) const
    {
        return !seen.empty() && now - since < kStatusHoldSeconds;
    }

    void HoverTip::frame(bool mouseMoved, bool steered, const std::string &over, double now)
    {
        if (mouseMoved)
            armed = true;
        else if (steered)
            armed = false;
        update(armed ? over : std::string(), now);
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
