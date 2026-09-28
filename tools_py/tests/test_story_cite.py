"""The citation test's own tests -- Sprint 11 Goal 6.

A guard that has never failed is not known to work, so every check here is proved by PLANTING the defect it
exists to catch, exactly as Sprint 11 Goal 9 plants a secret of each class. The hermetic cases use a fake
resolver so they run in any clone with no logs/ and no network; two cases use real git, because the point of
the checker is that it bites on this repository.
"""
import json
import os
import subprocess
import unittest

from tools_py.story import cite

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GOOD = """# The story

## 2026-09-12 .. 2026-09-14 - From picture to game

### 2026-09-13 - The first kill

**One instance shot another and both agreed about it.**

Two copies of the game met on a server and one killed the other. The scorer read the same thing on both sides.

*How:* the kill counter and the team-alive count were read out of both processes on one clock.

*But:* the second scorer disagreed on one of four rounds, so the two-scorer bar was recorded as not met.

`Cited:` `811b886` sprint-5 · run s5_t5_ladder2 · docs/research/22-kill-readout.md
"""


class FakeResolver(object):
    """Answers exactly what the checker asks, from dicts. No git, no filesystem."""

    def __init__(self, commits=None, tracked=(), unreachable=(), witnesses=None, logs=None, shallow=False):
        self._shallow = shallow
        self.commits = commits if commits is not None else {
            "811b886": ("811b886" + "0" * 33, "2026-09-13", "feat(sprint-5): the ladder's second launch, scored"),
        }
        self._tracked = set(tracked or ["docs/research/22-kill-readout.md"])
        self.unreachable = set(unreachable)
        self.witnesses = {"logs/parity/s5_t5_ladder2": {"source": "logs/parity/s5_t5_ladder2", "text": "KILL",
                                                        "bytes": 3, "sha256": "abc", "captured": "2026-09-20"}}
        if witnesses is not None:
            self.witnesses = witnesses
        self.logs = logs          # None: no logs/ on this machine; else {path: (bytes, sha256)}
        self.sizes = {"docs/story/img/2026-09-13-first-kill.png": 491420}
        self.inventory = ["2026-09-13-first-kill.png"]
        self._tracked.add("docs/story/img/2026-09-13-first-kill.png")

    def commit(self, sha):
        return self.commits.get(sha)

    def reachable(self, sha):
        return sha not in self.unreachable

    def tracked(self, path):
        return path in self._tracked

    def witness(self, path):
        return self.witnesses.get(path)

    def logs_present(self):
        return self.logs is not None

    def digest(self, path):
        return (self.logs or {}).get(path)

    def shallow(self):
        return self._shallow

    def size(self, path):
        return self.sizes.get(path)

    def picture_inventory(self):
        return set(self.inventory)


def kinds(problems):
    return sorted(p.kind for p in problems)


class TestCleanDocumentPasses(unittest.TestCase):
    def test_no_problems(self):
        self.assertEqual(cite.check(GOOD, None, FakeResolver()), [])

    def test_entry_is_parsed(self):
        entries = cite.parse_entries(GOOD)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].date, "2026-09-13")
        self.assertEqual(entries[0].title, "The first kill")


class TestGrammar(unittest.TestCase):
    def test_each_form(self):
        cits = cite.parse_cited("`Cited:` `811b886` the subject; with a semicolon · run s5_t5_ladder2 · "
                                "gate s9_p1_gate · docs/research/22-kill-readout.md · "
                                "`docs/STATUS.md` (2026-09-08 22:30 entry) · logs/parity/gate_first.out")
        self.assertEqual([c.kind for c in cits], ["commit", "run", "gate", "path", "path", "log"])
        self.assertEqual(cits[0].fragment, "the subject; with a semicolon")
        self.assertEqual(cits[4].ref, "docs/STATUS.md")
        self.assertEqual(cits[1].log_path, "logs/parity/s5_t5_ladder2")
        self.assertEqual(cits[2].log_path, "logs/parity/gate/s9_p1_gate")
        self.assertEqual(cits[5].log_path, "logs/parity/gate_first.out")

    def test_unparseable_is_a_failure_not_a_skip(self):
        for bad in ["`Cited:` see the commit from that morning",
                    "`Cited:` https://example.invalid/commit/811b886",
                    "`Cited:`"]:
            with self.assertRaises(ValueError):
                cite.parse_cited(bad)


class TestEachDefectIsCaught(unittest.TestCase):
    """One planted instance of every class of defect the checker exists to detect."""

    def plant(self, old, new):
        return cite.check(GOOD.replace(old, new), None, FakeResolver())

    def test_a_hash_that_does_not_resolve(self):
        self.assertIn("dead-commit", kinds(self.plant("`811b886`", "`deadbee`")))

    def test_a_hash_whose_subject_is_not_what_the_reader_is_told(self):
        problems = self.plant("`811b886` sprint-5", "`811b886` the first online login")
        self.assertIn("fragment-mismatch", kinds(problems))

    def test_a_commit_that_exists_but_is_not_reachable(self):
        problems = cite.check(GOOD, None, FakeResolver(unreachable=["811b886"]))
        self.assertIn("unreachable", kinds(problems))

    def test_a_run_with_no_witness(self):
        self.assertIn("no-witness", kinds(self.plant("run s5_t5_ladder2", "run s5_t5_ladder9")))

    def test_a_forward_reference_marked_with_its_real_date_passes(self):
        problems = self.plant("`811b886` sprint-5", "`811b886` (2026-09-13) sprint-5")
        self.assertEqual(kinds(problems), [])

    def test_a_forward_reference_marked_with_the_wrong_date(self):
        problems = self.plant("`811b886` sprint-5", "`811b886` (2026-09-14) sprint-5")
        self.assertIn("date-mismatch", kinds(problems))

    def test_a_fragment_that_elides_the_middle_of_a_long_subject_passes(self):
        problems = self.plant("`811b886` sprint-5", "`811b886` the ladder's second launch")
        self.assertNotIn("fragment-mismatch", kinds(problems))

    def test_a_witness_missing_a_field(self):
        w = {"logs/parity/s5_t5_ladder2": {"source": "x", "text": "KILL", "bytes": 3, "captured": "2026-09-20"}}
        self.assertIn("bad-witness", kinds(cite.check(GOOD, None, FakeResolver(witnesses=w))))

    def test_a_log_that_changed_under_its_witness(self):
        logs = {"logs/parity/s5_t5_ladder2": (3, "def")}
        self.assertIn("witness-drift", kinds(cite.check(GOOD, None, FakeResolver(logs=logs))))

    def test_a_log_that_still_matches_its_witness(self):
        logs = {"logs/parity/s5_t5_ladder2": (3, "abc")}
        self.assertEqual(cite.check(GOOD, None, FakeResolver(logs=logs)), [])

    def test_a_log_gone_from_a_machine_that_has_logs(self):
        self.assertIn("witness-orphaned", kinds(cite.check(GOOD, None, FakeResolver(logs={}))))

    def test_a_log_gone_but_declared_archived(self):
        w = {"logs/parity/s5_t5_ladder2": {"source": "x", "text": "KILL", "bytes": 3, "sha256": "abc",
                                           "captured": "2026-09-20", "archived": True}}
        self.assertEqual(cite.check(GOOD, None, FakeResolver(witnesses=w, logs={})), [])

    def test_a_clone_with_no_logs_at_all_still_checks_the_witness(self):
        self.assertEqual(cite.check(GOOD, None, FakeResolver(logs=None)), [])

    def test_a_path_git_does_not_track(self):
        problems = self.plant("docs/research/22-kill-readout.md", "docs/notes/private_note.md")
        self.assertIn("untracked-path", kinds(problems))

    def test_an_entry_with_no_citation_at_all(self):
        problems = self.plant("`Cited:` `811b886` sprint-5 · run s5_t5_ladder2 · "
                              "docs/research/22-kill-readout.md", "")
        self.assertIn("uncited", kinds(problems))

    def test_an_unparseable_citation_line(self):
        problems = self.plant("`811b886` sprint-5 · run s5_t5_ladder2 · docs/research/22-kill-readout.md",
                              "the commit from that morning")
        self.assertIn("unparseable", kinds(problems))

    def test_a_retracted_claim_stated_as_current(self):
        problems = self.plant("The scorer read the same thing on both sides.",
                              "The round was frozen at round start until the fix landed.")
        self.assertIn("retracted-claim", kinds(problems))

    def test_jargon_in_the_body(self):
        problems = self.plant("The scorer read the same thing on both sides.",
                              "The IOP had to agree before the count moved.")
        self.assertIn("jargon-in-body", kinds(problems))

    def test_jargon_in_a_how_line_is_allowed(self):
        problems = self.plant("*How:* the kill counter and the team-alive count were read out of both "
                              "processes on one clock.",
                              "*How:* the IOP model's counter and the team-alive count, on one clock.")
        self.assertNotIn("jargon-in-body", kinds(problems))

    def test_entries_out_of_date_order(self):
        doc = GOOD + "\n### 2026-09-11 - An earlier thing\n\n**A hook.**\n\nA body.\n\n`Cited:` `811b886` sprint-5\n"
        self.assertIn("out-of-order", kinds(cite.check(doc, None, FakeResolver())))

    def test_the_same_entry_twice(self):
        doc = GOOD + GOOD.split("## 2026-09-12 .. 2026-09-14 - From picture to game", 1)[1]
        self.assertIn("duplicate-entry", kinds(cite.check(doc, None, FakeResolver())))


class TestPictures(unittest.TestCase):
    """One captioned, tracked, inventoried, budgeted image per entry, under the one published path."""

    IMG = "\n![Both screens, a third of a second apart.](docs/story/img/2026-09-13-first-kill.png)\n"

    def with_image(self, line=None):
        return GOOD.replace("*How:*", (line if line is not None else self.IMG) + "\n*How:*")

    def test_a_good_picture_passes(self):
        self.assertEqual(cite.check(self.with_image(), None, FakeResolver()), [])

    def test_a_picture_outside_the_published_dir(self):
        doc = self.with_image("\n![c](docs/research/assets/22-first-kill.png)\n")
        self.assertIn("picture-outside-dir", kinds(cite.check(doc, None, FakeResolver())))

    def test_an_uncaptioned_picture(self):
        doc = self.with_image("\n![](docs/story/img/2026-09-13-first-kill.png)\n")
        self.assertIn("picture-uncaptioned", kinds(cite.check(doc, None, FakeResolver())))

    def test_an_untracked_or_missing_picture(self):
        doc = self.with_image("\n![c](docs/story/img/nothing.png)\n")
        ks = kinds(cite.check(doc, None, FakeResolver()))
        self.assertIn("picture-untracked", ks)
        self.assertIn("picture-missing", ks)
        self.assertIn("picture-not-inventoried", ks)

    def test_a_picture_over_budget(self):
        r = FakeResolver()
        r.sizes["docs/story/img/2026-09-13-first-kill.png"] = cite.PICTURE_MAX_BYTES + 1
        self.assertIn("picture-too-large", kinds(cite.check(self.with_image(), None, r)))

    def test_two_pictures_in_one_entry(self):
        doc = self.with_image(self.IMG + self.IMG)
        self.assertIn("too-many-pictures", kinds(cite.check(doc, None, FakeResolver())))

    def test_a_pasted_template_placeholder(self):
        doc = GOOD.replace("The scorer read", "Tag {{tag}}. The scorer read")
        self.assertIn("placeholder", kinds(cite.check(doc, None, FakeResolver())))


class TestVideos(unittest.TestCase):
    """A video takes the entry's one picture slot: same line, .mp4, its own budget, a poster frame beside it."""

    MP4 = "docs/story/img/2026-09-21-online-kill.mp4"
    VID = "\n![One round, both screens.](" + MP4 + ")\n"

    def resolver(self):
        r = FakeResolver()
        r.sizes[self.MP4] = 2_226_711
        r.sizes[self.MP4[:-4] + ".png"] = 323_661
        r._tracked.update([self.MP4, self.MP4[:-4] + ".png"])
        r.inventory.append("2026-09-21-online-kill.mp4")
        return r

    def with_video(self):
        return GOOD.replace("*How:*", self.VID + "\n*How:*")

    def test_a_good_video_passes(self):
        self.assertEqual(cite.check(self.with_video(), None, self.resolver()), [])

    def test_a_video_has_its_own_budget(self):
        r = self.resolver()
        r.sizes[self.MP4] = cite.PICTURE_MAX_BYTES + 1
        self.assertEqual(cite.check(self.with_video(), None, r), [])
        r.sizes[self.MP4] = cite.VIDEO_MAX_BYTES + 1
        self.assertIn("picture-too-large", kinds(cite.check(self.with_video(), None, r)))

    def test_a_video_without_a_tracked_poster(self):
        r = self.resolver()
        r._tracked.discard(self.MP4[:-4] + ".png")
        self.assertIn("video-no-poster", kinds(cite.check(self.with_video(), None, r)))
        r = self.resolver()
        del r.sizes[self.MP4[:-4] + ".png"]
        self.assertIn("video-no-poster", kinds(cite.check(self.with_video(), None, r)))

    def test_the_site_renders_a_player_not_an_img(self):
        from tools_py.story import site
        doc = site.parse_document(self.with_video())
        entry = doc["eras"][0]["entries"][0]
        page = site.render_entry(entry, "https://example.test/r", "/story/img", 1)
        # the poster's width and height are written when the poster file is beside the page (it is, here), so the
        # layout is settled before it loads -- the story page's anchor fix of 2026-09-27
        self.assertRegex(page, r'<video controls preload="metadata" playsinline( width="\d+" height="\d+")? poster="/story/img/2026-09-21-online-kill\.png(\?v=[0-9a-f]{10})?">')
        self.assertRegex(page, r'<source src="/story/img/2026-09-21-online-kill\.mp4(\?v=[0-9a-f]{10})?" type="video/mp4">')
        self.assertIn("<figcaption>One round, both screens.</figcaption>", page)
        self.assertNotIn("<img", page)

    def test_media_urls_carry_the_files_hash(self):
        """A re-encoded file under an unchanged URL is what Cloudflare kept serving; the stamp is the file's own."""
        from tools_py.story import site
        real = os.path.join(ROOT, cite.PICTURE_DIR, "2026-09-21-online-kill.mp4")
        if not os.path.isfile(real):
            self.skipTest("the video is not in this tree")
        url = site.media_url("/story/img", "2026-09-21-online-kill.mp4")
        self.assertRegex(url, r"^/story/img/2026-09-21-online-kill\.mp4\?v=[0-9a-f]{10}$")
        self.assertEqual(site.media_url("/story/img", "no-such-file.png"), "/story/img/no-such-file.png")


class TestShallowClone(unittest.TestCase):
    """CI checks out depth 1, so git holds almost none of the cited commits. The data file's stored date and
    subject vouch for them instead (spec 4.4 decision 4); the check neither skips nor calls 208 commits dead."""

    TL = {"schema": 1, "entries": [{"date": "2026-09-13", "title": "The first kill", "citations": [
        {"kind": "commit", "ref": "811b886", "sha": "811b886" + "0" * 33, "date": "2026-09-13",
         "subject": "feat(sprint-5): the ladder's second launch, scored"}]}]}

    def test_a_commit_git_cannot_see_is_vouched_for_by_the_data_file(self):
        r = FakeResolver(commits={}, shallow=True)
        self.assertEqual(cite.check(GOOD, self.TL, r), [])

    def test_the_fragment_is_still_checked_against_the_stored_subject(self):
        r = FakeResolver(commits={}, shallow=True)
        doc = GOOD.replace("`811b886` sprint-5", "`811b886` the first online login")
        self.assertIn("fragment-mismatch", kinds(cite.check(doc, self.TL, r)))

    def test_a_commit_neither_git_nor_the_data_file_knows_is_dead(self):
        r = FakeResolver(commits={}, shallow=True)
        self.assertIn("dead-commit", kinds(cite.check(GOOD, None, r)))

    def test_a_full_clone_does_not_take_the_data_file_s_word_for_it(self):
        r = FakeResolver(commits={}, shallow=False)
        self.assertIn("dead-commit", kinds(cite.check(GOOD, self.TL, r)))


class TestKnownDead(unittest.TestCase):
    """A dead citation that has been declared with a reason is a record; an undeclared one is a defect."""

    def test_a_declared_dead_hash_does_not_fail(self):
        doc = GOOD.replace("`811b886` sprint-5", "`841a6fc` the VU1 register-file build")
        self.assertEqual(kinds(cite.check(doc, None, FakeResolver())), [])

    def test_the_two_declared_ones_really_are_dead_in_this_repository(self):
        for sha in ("841a6fc", "60fe75c"):
            p = subprocess.run(["git", "cat-file", "-e", sha + "^{commit}"],
                               cwd=ROOT, capture_output=True, text=True)
            self.assertNotEqual(p.returncode, 0,
                                "%s resolves now -- remove it from KNOWN_DEAD and re-point the citation" % sha)
            self.assertIn(sha, cite.KNOWN_DEAD)
            self.assertTrue(cite.KNOWN_DEAD[sha].strip(), "a KNOWN_DEAD entry must carry its reason")


class TestTimelineAgreesWithGitAndWithTheProse(unittest.TestCase):
    def timeline(self, **over):
        row = {"date": "2026-09-13", "title": "The first kill",
               "citations": [{"kind": "commit", "ref": "811b886", "date": "2026-09-13",
                              "subject": "feat(sprint-5): the ladder's second launch, scored"}]}
        row.update(over)
        return {"schema": 1, "entries": [row]}

    def test_agreement_passes(self):
        self.assertEqual(cite.check(GOOD, self.timeline(), FakeResolver()), [])

    def test_a_recorded_date_that_git_contradicts(self):
        t = self.timeline()
        t["entries"][0]["citations"][0]["date"] = "2026-09-14"
        self.assertIn("date-drift", kinds(cite.check(GOOD, t, FakeResolver())))

    def test_a_recorded_subject_that_git_contradicts(self):
        t = self.timeline()
        t["entries"][0]["citations"][0]["subject"] = "feat: something else entirely"
        self.assertIn("subject-drift", kinds(cite.check(GOOD, t, FakeResolver())))

    def test_an_entry_in_the_story_and_not_in_the_data(self):
        t = self.timeline(title="A different entry")
        self.assertIn("not-in-timeline", kinds(cite.check(GOOD, t, FakeResolver())))

    def test_an_entry_in_the_data_and_not_in_the_story(self):
        t = self.timeline()
        t["entries"].append({"date": "2026-09-14", "title": "Never written", "citations": []})
        self.assertIn("not-in-story", kinds(cite.check(GOOD, t, FakeResolver())))


class TestAgainstRealGit(unittest.TestCase):
    """The checker has to work against this repository, not only against a fake."""

    def setUp(self):
        self.resolver = cite.GitResolver(root=ROOT)
        if self.resolver.commit("HEAD") is None:      # pragma: no cover - not a git checkout
            self.skipTest("not a git checkout")

    def test_head_resolves_with_its_date_and_subject(self):
        full, date, subject = self.resolver.commit("HEAD")
        self.assertEqual(len(full), 40)
        self.assertRegex(date, r"^\d{4}-\d{2}-\d{2}$")
        self.assertTrue(subject)

    def test_a_fabricated_hash_does_not(self):
        self.assertIsNone(self.resolver.commit("0123456"))

    def test_the_first_commit_is_reachable_and_a_tracked_path_is_tracked(self):
        if self.resolver.shallow():
            # a depth-1 checkout cannot hold 2026-09-02; the shallow path is what TestShallowClone proves
            self.assertIsNone(self.resolver.commit("55f5170"))
        else:
            self.assertTrue(self.resolver.reachable("55f5170"))
        self.assertTrue(self.resolver.tracked("docs/KNOWN.md"))
        self.assertFalse(self.resolver.tracked("logs/parity/nothing_here.txt"))


class TestLogsPresentMeansTheArchive(unittest.TestCase):
    """A logs/ directory exists on every machine that has run the suite; only the owner's holds the runs the
    witnesses were frozen from. Level 2/3 must not fire on a bare directory (CI run 35495411398 did)."""

    def setUp(self):
        import tempfile
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, "logs", "parity", "gate"))
        self.saved = os.environ.pop("STORY_VERIFY_LOGS", None)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self.saved is not None:
            os.environ["STORY_VERIFY_LOGS"] = self.saved
        else:
            os.environ.pop("STORY_VERIFY_LOGS", None)

    def test_a_bare_logs_directory_is_not_the_archive(self):
        self.assertFalse(cite.GitResolver(root=self.tmp).logs_present())

    def test_the_archive_marker_is(self):
        with open(os.path.join(self.tmp, "logs", "ARCHIVED_TO_D.txt"), "w") as f:
            f.write("marker")
        self.assertTrue(cite.GitResolver(root=self.tmp).logs_present())

    def test_the_environment_forces_it_either_way(self):
        os.environ["STORY_VERIFY_LOGS"] = "1"
        self.assertTrue(cite.GitResolver(root=self.tmp).logs_present())
        os.environ["STORY_VERIFY_LOGS"] = "0"
        with open(os.path.join(self.tmp, "logs", "ARCHIVED_TO_D.txt"), "w") as f:
            f.write("marker")
        self.assertFalse(cite.GitResolver(root=self.tmp).logs_present())


class TestSiteRefusesAFilesystemPathAsAUrl(unittest.TestCase):
    """Git Bash turned --img /story/img into C:/Program Files/Git/story/img once and the live page lost its pictures."""

    def test_a_drive_letter_or_program_files_is_refused(self):
        from tools_py.story import site
        import io as _io, contextlib
        for bad in ("C:/Program Files/Git/story/img", "c:/x", "D:\story"):
            err = _io.StringIO()
            with contextlib.redirect_stderr(err):
                rc = site.main(["--img", bad, "--out", os.devnull])
            self.assertEqual(rc, 2, bad)
            self.assertIn("MSYS_NO_PATHCONV", err.getvalue())

    def test_a_url_path_is_accepted(self):
        from tools_py.story import site
        import tempfile
        story = os.path.join(ROOT, "docs", "STORY.md")
        if not os.path.exists(story):
            self.skipTest("docs/STORY.md not written yet")
        # The repository copy inlines the site's design system and refuses to render without it (site.py, 2026-09-28);
        # the default --ds-dir is ../scotho's, which CI never has, so the test brings its own four layer files.
        with tempfile.TemporaryDirectory() as ds:
            for name in site.DS_FILES:
                with open(os.path.join(ds, name), "w", encoding="utf-8") as f:
                    f.write("/* %s */\n" % name)
            rc = site.main(["--img", "/story/img", "--logo", "/img/logo.webp", "--out", os.devnull, "--ds-dir", ds])
        self.assertEqual(rc, 0)


class TestTheRealStoryIfItExists(unittest.TestCase):
    """Once docs/STORY.md exists, the suite checks the real document on every run."""

    def test_story_document_is_clean(self):
        story = os.path.join(ROOT, "docs", "STORY.md")
        if not os.path.exists(story):
            self.skipTest("docs/STORY.md not written yet")
        with open(story, encoding="utf-8") as f:
            markdown = f.read()
        timeline_path = os.path.join(ROOT, "docs", "story", "timeline.json")
        timeline = None
        if os.path.exists(timeline_path):
            with open(timeline_path, encoding="utf-8") as f:
                timeline = json.load(f)
        problems = cite.check(markdown, timeline, cite.GitResolver(root=ROOT))
        self.assertEqual(problems, [], "\n".join(repr(p) for p in problems))


if __name__ == "__main__":
    unittest.main()
