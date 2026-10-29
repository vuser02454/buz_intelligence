from django.test import SimpleTestCase

from report_generator.templatetags.report_tags import highlight


class HighlightFilterTests(SimpleTestCase):
    def test_marks_figures_and_keywords(self):
        out = highlight('Base revenue is ₹1,20,000 with 12% risk and 3 competitors within 500 m, score 72/100.')
        self.assertIn('<mark class="hl-num">₹1,20,000</mark>', out)
        self.assertIn('<mark class="hl-num">12%</mark>', out)
        self.assertIn('<mark class="hl-num">500 m</mark>', out)
        self.assertIn('<mark class="hl-num">72/100</mark>', out)
        self.assertIn('<b class="hl-kw">revenue</b>', out)
        self.assertIn('<b class="hl-kw">competitors</b>', out)

    def test_escapes_before_marking(self):
        out = highlight('<script>alert(1)</script> revenue')
        self.assertNotIn('<script>', out)
        self.assertIn('&lt;script&gt;', out)

    def test_go_verdict_only_when_capitalised(self):
        self.assertIn('<b class="hl-kw">No-Go</b>', highlight('Verdict: No-Go'))
        self.assertNotIn('hl-kw', highlight('go ahead and visit'))

    def test_none_is_empty(self):
        self.assertEqual(highlight(None), '')
