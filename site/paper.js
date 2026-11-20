const cover = document.querySelector(".cover");
const tear = document.querySelector(".tear-tail");
const contents = document.querySelector(".contents");
const links = Array.from(contents.querySelectorAll("a"));
const sections = links.map(link => document.getElementById(link.hash.slice(1)));
const compact = matchMedia("(max-width: 991.98px)");
const still = matchMedia("(prefers-reduced-motion: reduce)");
let current;
let lastPeel;
let lastFray;
let scheduled = false;

function update() {
	scheduled = false;
	const inset = compact.matches ? contents.getBoundingClientRect().height : 0;
	const line = inset + Math.min(innerHeight * .18, 112);
	let index = links.length - 1;
	if (Math.ceil(scrollY + innerHeight) < document.documentElement.scrollHeight) {
		while (index > 0 && sections[index].getBoundingClientRect().top > line) index--;
	}
	if (current !== links[index]) {
		current?.removeAttribute("aria-current");
		current = links[index];
		current.setAttribute("aria-current", "location");
	}

	// The stationary cover sets the tear distance; the loose edge outlasts a quick wheel stroke.
	const bounds = cover.getBoundingClientRect();
	const travel = Math.max(1, Math.min(bounds.height * .82, innerHeight * .64));
	const peel = still.matches ? 0 : Math.max(0, Math.min(1, (inset + 52 - bounds.top) / travel));
	const fray = Math.max(0, Math.min(peel * 2, 1, 1 + (bounds.bottom - inset) / (innerHeight * .54)));
	if (peel !== lastPeel) {
		cover.style.setProperty("--peel", peel);
		lastPeel = peel;
	}
	if (fray !== lastFray || tear.style.top !== `${inset}px`) {
		tear.style.setProperty("--fray", fray);
		tear.style.top = `${inset}px`;
		lastFray = fray;
	}
}

function schedule() {
	if (scheduled) return;
	scheduled = true;
	requestAnimationFrame(update);
}

addEventListener("scroll", schedule, { passive: true });
addEventListener("resize", schedule);
addEventListener("hashchange", schedule);
still.addEventListener("change", schedule);
document.fonts.ready.then(schedule);
schedule();

let stopPlayback;

for (const button of document.querySelectorAll(".press-run")) {
	const proof = button.closest("figure");
	const versions = [...proof.querySelectorAll('input[type="radio"]')].slice(Number(button.dataset.start || 1) - 1);
	const meter = proof.querySelector("progress");
	const stack = document.createElement("span");
	stack.className = "ink-stack";
	proof.querySelector(".press-art").append(stack);
	let timer;
	function reset() {
		clearTimeout(timer);
		if (stopPlayback === reset) stopPlayback = undefined;
		stack.replaceChildren();
		stack.classList.remove("dry");
		meter.hidden = true;
		button.textContent = "Play";
		button.classList.remove("playing");
	}
	button.hidden = false;
	proof.addEventListener("change", reset);
	proof.addEventListener("click", event => {
		if (event.target.matches('input[type="radio"]')) reset();
	});
	button.addEventListener("click", () => {
		if (stopPlayback === reset) return reset();
		stopPlayback?.();
		reset();
		stopPlayback = reset;
		button.textContent = "Stop";
		button.classList.add("playing");
		const strikes = versions.flatMap(version => {
			const stamp = proof.querySelector(`[data-leaf="${version.value}"] .stamp`);
			const passed = stamp.classList.contains("good");
			return Array(passed ? 1 : 2 + Math.floor(Math.random() * 3)).fill({ version, stamp, passed });
		});
		meter.max = strikes.length;
		meter.hidden = false;
		let index = still.matches ? strikes.length - 1 : 0;
		function strike() {
			const { version, stamp, passed } = strikes[index++];
			version.checked = true;
			const mark = document.createElement("span");
			mark.className = passed ? "ink-hit good" : "ink-hit";
			mark.textContent = passed ? stamp.textContent : "Not passed";
			if (!passed) {
				mark.style.rotate = `${(index % 2 ? -1 : 1) * (5 + Math.random() * 8)}deg`;
				mark.style.translate = `${index % 2 ? -5 : 5}% ${((index * 37) % 85) - 42}%`;
			}
			stack.append(mark);
			meter.value = index;
			if (index < strikes.length) {
				timer = setTimeout(strike, strikes[index].version === version ? 215 : 350);
			} else {
				button.textContent = "Replay";
				button.classList.remove("playing");
				stack.classList.add("dry");
				stopPlayback = undefined;
			}
		}
		strike();
	});
}
still.addEventListener("change", () => stopPlayback?.());
document.addEventListener("visibilitychange", () => { if (document.hidden) stopPlayback?.(); });
