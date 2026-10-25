"""
End-to-end tests for Leeway. Drives the real app in headless Chromium.

    pip install playwright && python -m playwright install chromium
    python tests/e2e_test.py

Starts its own static server, so nothing else needs to be running.
"""
import functools
import http.server
import json
import os
import re
import tempfile
import threading
import traceback

from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOW = "2026-11-02T09:00"  # a Monday morning; the app's planning clock is frozen here
PORT = 8765
URL = f"http://localhost:{PORT}/index.html"


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    handler = functools.partial(Quiet, directory=ROOT)
    srv = http.server.ThreadingHTTPServer(("localhost", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


def fresh(browser, viewport=None, clock=False):
    ctx = browser.new_context(viewport=viewport or {"width": 1280, "height": 800}, accept_downloads=True)
    ctx.add_init_script(f"window.LEEWAY_NOW = '{NOW}'")
    page = ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.on("console", lambda m: page.errors.append(m.text) if m.type == "error" else None)
    page.on("dialog", lambda d: d.accept())  # confirm() prompts
    if clock:
        page.clock.install()
    page.goto(URL)
    return ctx, page


def add_assignment(page, title, est, date, time="23:59", course=None):
    page.keyboard.press("Escape")
    page.goto(URL + "#assignments")
    page.get_by_role("button", name="Add assignment").first.click()
    dlg = page.locator("#assignmentDialog")
    dlg.locator("[name=title]").fill(title)
    dlg.locator("[name=estHours]").fill(str(est))
    dlg.locator("[name=dueDate]").fill(date)
    dlg.locator("[name=dueTime]").fill(time)
    dlg.get_by_role("button", name="Save assignment").click()
    expect(dlg).not_to_be_visible()


def stored(page):
    return json.loads(page.evaluate("localStorage.getItem('leeway.v1')"))


@test
def empty_state_and_no_errors(browser):
    ctx, page = fresh(browser)
    expect(page.locator("h1")).to_contain_text("how much leeway you have")
    for r in ["plan", "assignments", "focus", "settings"]:
        page.goto(URL + "#" + r)
        expect(page.locator("#main h1")).to_be_visible()
    assert not page.errors, page.errors
    ctx.close()


@test
def form_validation_blocks_bad_input(browser):
    ctx, page = fresh(browser)
    page.goto(URL + "#assignments")
    page.get_by_role("button", name="Add assignment").first.click()
    dlg = page.locator("#assignmentDialog")
    dlg.locator("[name=estHours]").fill("0")
    dlg.get_by_role("button", name="Save assignment").click()
    expect(dlg).to_be_visible()
    expect(dlg.locator(".form-error")).to_contain_text("Give the assignment a title")
    expect(dlg.locator(".form-error")).to_contain_text("between 0.25 and 200")
    assert stored(page)["assignments"] == [] if page.evaluate("localStorage.getItem('leeway.v1')") else True
    ctx.close()


@test
def adding_an_assignment_builds_a_plan(browser):
    ctx, page = fresh(browser)
    add_assignment(page, "Subnetting lab", 4.5, "2026-11-05")
    expect(page.locator(".a-card")).to_have_count(1)
    expect(page.locator(".a-card")).to_contain_text("4 h 30 min left")
    page.goto(URL + "#today")
    expect(page.locator(".hero-sentence")).to_contain_text("Subnetting lab")
    page.goto(URL + "#plan")
    total = page.evaluate("""() => [...document.querySelectorAll('.day-card li b')]
        .map(b => b.textContent).join('|')""")
    assert total, "plan should list study blocks"
    data = stored(page)
    assert data["assignments"][0]["estHours"] == 4.5
    ctx.close()


@test
def overload_is_flagged_with_shortfall(browser):
    ctx, page = fresh(browser)
    # Monday 09:00, default 3 h/day Mon+Tue -> 6 h before Tuesday night; 10 h needed
    add_assignment(page, "Impossible essay", 10, "2026-11-03")
    page.goto(URL + "#today")
    alert = page.locator(".alert.risk").first
    expect(alert).to_contain_text("Impossible essay needs 4 h more")
    expect(page.locator(".status.at-risk").first).to_have_text("Short by 4 h")
    ctx.close()


@test
def logging_time_updates_progress_and_persists(browser):
    ctx, page = fresh(browser)
    add_assignment(page, "Reading notes", 3, "2026-11-10")
    page.get_by_role("button", name="Log time").click()
    page.locator("#logQuick [data-min='60']").click()
    page.locator("#logDialog").get_by_role("button", name="Log time").click()
    expect(page.locator(".a-card")).to_contain_text("1 h of 3 h done")
    page.reload()
    page.goto(URL + "#assignments")
    expect(page.locator(".a-card")).to_contain_text("2 h left")
    page.goto(URL + "#today")
    expect(page.locator(".panel h2 small").first).to_have_text("2 h available")  # 3 h minus 1 h logged today
    ctx.close()


@test
def done_delete_and_undo(browser):
    ctx, page = fresh(browser)
    add_assignment(page, "Quiz", 1, "2026-11-04")
    page.get_by_role("button", name="Mark done").click()
    expect(page.locator(".a-card")).to_have_count(0)
    page.locator("#toast button").click()  # Undo
    expect(page.locator(".a-card")).to_have_count(1)
    page.get_by_role("button", name="Delete").click()
    expect(page.locator(".a-card")).to_have_count(0)
    page.locator("#toast button").click()  # Undo
    expect(page.locator(".a-card")).to_contain_text("Quiz")
    ctx.close()


@test
def focus_session_logs_time_automatically(browser):
    ctx, page = fresh(browser, clock=True)
    add_assignment(page, "Lab report", 2, "2026-11-06")
    page.get_by_role("button", name="Start focus").click()
    expect(page).to_have_url(re.compile("#focus"))
    expect(page.locator("#focusTask")).to_have_value(re.compile(".+"))
    page.clock.run_for(5_000)
    expect(page.locator("#dialPhase")).to_have_text("Focusing")
    page.clock.run_for(25 * 60 * 1000)
    expect(page.locator("#dialPhase")).to_have_text("Short break")
    expect(page.locator(".session-list")).to_contain_text("25 min")
    a = stored(page)["assignments"][0]
    assert abs(a["doneHours"] - 25 / 60) < 0.01, a["doneHours"]
    ctx.close()


@test
def finish_early_logs_partial_session(browser):
    ctx, page = fresh(browser, clock=True)
    add_assignment(page, "Essay", 2, "2026-11-06")
    page.get_by_role("button", name="Start focus").click()
    page.clock.run_for(12 * 60 * 1000 + 500)
    page.get_by_role("button", name="Finish and log").click()
    expect(page.locator(".session-list")).to_contain_text("12 min")
    expect(page.locator("#dialTime")).to_have_text("25:00")
    ctx.close()


@test
def study_hours_setting_changes_capacity(browser):
    ctx, page = fresh(browser)
    add_assignment(page, "Project", 4, "2026-11-09")
    page.goto(URL + "#settings")
    page.locator("[data-cap='1']").fill("5")  # Monday
    page.goto(URL + "#today")
    expect(page.locator(".panel h2 small").first).to_have_text("5 h available")
    ctx.close()


@test
def plan_mode_toggle(browser):
    ctx, page = fresh(browser)
    add_assignment(page, "Project", 9, "2026-11-12")
    page.goto(URL + "#plan")
    spread_today = page.locator(".day-card").first.locator(".fill-meter").inner_text()
    page.get_by_role("button", name="Get ahead").click()
    expect(page.get_by_role("button", name="Get ahead")).to_have_attribute("aria-pressed", "true")
    ahead_today = page.locator(".day-card").first.locator(".fill-meter").inner_text()
    assert spread_today != ahead_today, (spread_today, ahead_today)
    assert ahead_today.startswith("3 h"), ahead_today
    ctx.close()


@test
def calendar_export(browser):
    ctx, page = fresh(browser)
    add_assignment(page, "Lab; with, punctuation", 3, "2026-11-05")
    page.goto(URL + "#plan")
    with page.expect_download() as dl:
        page.get_by_role("button", name="Export to calendar").click()
    text = open(dl.value.path()).read()
    assert text.startswith("BEGIN:VCALENDAR") and text.rstrip().endswith("END:VCALENDAR")
    assert text.count("BEGIN:VEVENT") >= 2
    assert "Lab\\; with\\, punctuation" in text
    ctx.close()


@test
def backup_round_trip_and_bad_import(browser):
    ctx, page = fresh(browser)
    add_assignment(page, "Keep me", 2, "2026-11-08")
    page.goto(URL + "#settings")
    with page.expect_download() as dl:
        page.get_by_role("button", name="Export backup").click()
    backup = dl.value.path()
    page.get_by_role("button", name="Delete all data").click()
    page.goto(URL + "#assignments")
    expect(page.locator(".a-card")).to_have_count(0)
    page.goto(URL + "#settings")
    bad = os.path.join(tempfile.mkdtemp(), "bad.json")
    open(bad, "w").write("{not json")
    page.locator("#importFile").set_input_files(bad)
    expect(page.locator("#toast")).to_contain_text("isn’t a Leeway backup")
    page.locator("#importFile").set_input_files(backup)
    expect(page.locator("#toast")).to_contain_text("Imported 1")
    page.goto(URL + "#assignments")
    expect(page.locator(".a-card")).to_contain_text("Keep me")
    ctx.close()


@test
def user_text_is_escaped(browser):
    ctx, page = fresh(browser)
    add_assignment(page, "<img src=x onerror=window.pwned=1>", 1, "2026-11-05")
    page.goto(URL + "#today")
    expect(page.locator(".hero-sentence")).to_contain_text("<img src=x")
    assert page.evaluate("window.pwned") is None
    assert page.locator("#main img").count() == 0
    ctx.close()


@test
def sample_data_and_mobile_layout(browser):
    ctx, page = fresh(browser, viewport={"width": 375, "height": 740})
    page.get_by_role("button", name="Try it with sample data").click()
    for r in ["today", "plan", "assignments", "focus", "settings"]:
        page.goto(URL + "#" + r)
        page.wait_for_timeout(100)
        overflow = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        assert overflow <= 0, f"{r} scrolls sideways by {overflow}px"
    expect(page.locator(".nav")).to_be_visible()
    assert not page.errors, page.errors
    ctx.close()


@test
def keyboard_shortcut_opens_form(browser):
    ctx, page = fresh(browser)
    page.locator("body").press("n")
    expect(page.locator("#assignmentDialog")).to_be_visible()
    page.keyboard.press("Escape")
    expect(page.locator("#assignmentDialog")).not_to_be_visible()
    ctx.close()


if __name__ == "__main__":
    srv = serve()
    failed = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for t in TESTS:
            try:
                t(browser)
                print(f"ok      {t.__name__}")
            except Exception:
                failed += 1
                print(f"FAILED  {t.__name__}")
                traceback.print_exc(limit=3)
        browser.close()
    srv.shutdown()
    print(f"\n{len(TESTS) - failed} passed, {failed} failed")
    raise SystemExit(1 if failed else 0)
