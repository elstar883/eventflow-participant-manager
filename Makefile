.PHONY: check serve

check:
	node scripts/validate.mjs

serve:
	python3 -m http.server 8080 --directory app
