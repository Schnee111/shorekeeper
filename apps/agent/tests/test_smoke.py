"""Smoke tests untuk migrasi G3 (TASK-1.1).

Tidak ada network call — hanya memastikan modul yang dimigrasi import bersih
dan perilaku voice-text bridge (bagian inti hermes_llm) berfungsi.
"""

from agent import Assistant
from hermes_llm import clean_voice_text, contains_scaffold


def test_agent_module_imports():
    assert Assistant is not None


def test_clean_voice_text_strips_bracket_cue():
    assert clean_voice_text("[warm] Halo, Schnee.") == "Halo, Schnee."


def test_clean_voice_text_normalizes_em_dash():
    assert clean_voice_text("Kamu — apa kabar?") == "Kamu, apa kabar?"


def test_contains_scaffold_detects_interruption_marker():
    assert contains_scaffold("[This response was interrupted by a user correction.]")
    assert not contains_scaffold("Biasa saja.")
