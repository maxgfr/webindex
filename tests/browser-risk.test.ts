import { describe, expect, it } from "vitest";
import { assessRisk, guardAction, RiskRefusedError, riskContext } from "../src/browser/risk.js";
import { FakePage } from "./helpers/fake-page.js";

const click = (label: string, over: object = {}) => assessRisk({ action: "click", label, isSubmit: false, formHasPassword: false, ...over });

describe("assessRisk: click", () => {
  it.each([
    "Pay",
    "Payer maintenant",
    "Paiement sécurisé",
    "Purchase",
    "Buy now",
    "Acheter",
    "Order",
    "Commander",
    "Proceed to checkout",
    "Place order",
    "Confirm",
    "Confirmer la commande",
    "Validate",
    "Valider",
    "Delete",
    "Supprimer l'annonce",
    "Remove",
    "Publish",
    "Publier",
    "Post",
    "Poster",
    "Send",
    "Envoyer le message",
    "Submit",
    "Soumettre",
    "Transfer",
    "Faire un virement",
    "Subscribe",
    "S'abonner",
    "S’abonner",
    "Unsubscribe",
    "Se désabonner",
    "Résilier mon contrat",
    "Cancel subscription",
    "Sign the contract",
    "Signer",
    "Book",
    "Réserver",
    "Donate",
    "Faire un don",
    "Close account",
    "Fermer le compte",
    "Déposer une annonce",
    "Deposit",
  ])("refuses %s", (label) => {
    const r = click(label);
    expect(r.risky).toBe(true);
    expect(r.reason).toBeTruthy();
  });

  it("is accent and case insensitive", () => {
    expect(click("PAIEMENT").risky).toBe(true);
    expect(click("resilier").risky).toBe(true);
    expect(click("DÉPOSER").risky).toBe(true);
    expect(click("deposer").risky).toBe(true);
  });

  it("matches whole words only", () => {
    for (const label of [
      "Compost",
      "Reorder",
      "Sending soon",
      "Unpaid",
      "Postal code",
      "Passenger",
      "Digital signage",
      "Booking.com logo",
      "Next",
      "Continue",
      "Search",
      "Menu",
      "Add to cart",
      "Ajouter au panier",
      "Voir plus",
    ]) {
      expect(click(label).risky, label).toBe(false);
    }
  });

  it("does not take signing in or out for a signature", () => {
    expect(click("Sign in").risky).toBe(false);
    expect(click("Sign out").risky).toBe(false);
    expect(click("Sign up").risky).toBe(true);
  });

  it("names the control and the matched word in the reason", () => {
    expect(click("Payer 12,00 €").reason).toMatch(/Payer 12,00 €/);
    expect(click("Payer 12,00 €").reason).toMatch(/payer/i);
  });

  it("flags a submit of a form with a password field whatever the label", () => {
    const r = click("Continue", { isSubmit: true, formHasPassword: true });
    expect(r).toEqual({ risky: true, reason: "form contains a password field — let the human log in" });
  });

  it("does not flag a password form when the click is not a submit", () => {
    expect(click("Show password", { isSubmit: false, formHasPassword: true }).risky).toBe(false);
  });
});

describe("assessRisk: press", () => {
  const press = (key: string, over: object = {}) => assessRisk({ action: "press", key, label: "", isSubmit: false, formHasPassword: false, ...over });

  it("only cares about Enter and NumpadEnter", () => {
    expect(press("Tab", { isSubmit: true, formHasPassword: true, submitLabel: "Pay" }).risky).toBe(false);
    expect(press("Escape", { role: "button", label: "Delete" }).risky).toBe(false);
    expect(press("Enter", { isSubmit: true, submitLabel: "Pay" }).risky).toBe(true);
    expect(press("NumpadEnter", { isSubmit: true, submitLabel: "Commander" }).risky).toBe(true);
  });

  it("is risky when the form's submit control matches, not the field's own label", () => {
    expect(press("Enter", { role: "textbox", label: "Message to send", isSubmit: true, submitLabel: "Next" }).risky).toBe(false);
    expect(press("Enter", { role: "textbox", label: "Search", isSubmit: true, submitLabel: "Search" }).risky).toBe(false);
  });

  it("is risky on a form with a password field", () => {
    expect(press("Enter", { role: "textbox", isSubmit: true, formHasPassword: true, submitLabel: "Log in" })).toEqual({
      risky: true,
      reason: "form contains a password field — let the human log in",
    });
  });

  it("treats Enter on a focused button or link as a click on it", () => {
    expect(press("Enter", { role: "button", label: "Delete", isSubmit: false }).risky).toBe(true);
    expect(press("Enter", { role: "link", label: "Home" }).risky).toBe(false);
  });

  it("ignores Enter outside a form on a plain field", () => {
    expect(press("Enter", { role: "textbox", label: "Send", isSubmit: false }).risky).toBe(false);
  });

  it("ignores a missing key", () => {
    expect(assessRisk({ action: "press", label: "Delete", role: "button", isSubmit: true, formHasPassword: false }).risky).toBe(false);
  });
});

describe("riskContext", () => {
  it("resolves the node and calls the collector on it, then releases it", async () => {
    const p = new FakePage();
    p.handle("DOM.resolveNode", () => ({ object: { objectId: "obj-1" } }));
    const value = { role: "button", label: "Payer", isSubmit: true, formHasPassword: false, submitLabel: "Payer" };
    p.handle("Runtime.callFunctionOn", () => ({ result: { value } }));
    const ctx = await riskContext(p, 42, "click");
    expect(ctx).toEqual(value);
    expect(p.calls[0]).toEqual({ method: "DOM.resolveNode", params: { backendNodeId: 42 } });
    const call = p.calls[1];
    expect(call?.method).toBe("Runtime.callFunctionOn");
    expect(call?.params).toMatchObject({ objectId: "obj-1", returnByValue: true, arguments: [{ value: "click" }] });
    expect(String(call?.params.functionDeclaration)).toContain("password");
    expect(p.calls[2]).toEqual({ method: "Runtime.releaseObject", params: { objectId: "obj-1" } });
  });

  it("collects on the focused element for a press", async () => {
    const p = new FakePage();
    const value = { role: "textbox", label: "", isSubmit: true, formHasPassword: true, submitLabel: "Log in" };
    p.handle("Runtime.evaluate", () => ({ result: { value } }));
    expect(await riskContext(p, undefined, "press", "Enter")).toEqual(value);
    expect(p.methods()).toEqual(["Runtime.evaluate"]);
    expect(String(p.calls[0]?.params.expression)).toContain("document.activeElement");
    expect(p.calls[0]?.params.returnByValue).toBe(true);
  });

  it("fails on a node that cannot be resolved, and when click has no node", async () => {
    const p = new FakePage();
    p.handle("DOM.resolveNode", () => {
      throw new Error("No node with given id found");
    });
    await expect(riskContext(p, 1, "click")).rejects.toThrow(/No node/);
    await expect(riskContext(p, undefined, "click")).rejects.toThrow(/backendNodeId/);
  });

  it("falls back to a blank context when the page returns nothing usable", async () => {
    const p = new FakePage();
    p.handle("DOM.resolveNode", () => ({ object: { objectId: "o" } }));
    p.handle("Runtime.callFunctionOn", () => ({ result: {} }));
    p.handle("Runtime.releaseObject", () => {
      throw new Error("gone");
    });
    expect(await riskContext(p, 1, "click")).toEqual({ role: "", label: "", isSubmit: false, formHasPassword: false, submitLabel: "" });
  });
});

describe("guardAction", () => {
  const scripted = (value: object) => {
    const p = new FakePage();
    p.handle("DOM.resolveNode", () => ({ object: { objectId: "o" } }));
    p.handle("Runtime.callFunctionOn", () => ({ result: { value } }));
    p.handle("Runtime.evaluate", () => ({ result: { value } }));
    return p;
  };
  const pay = { role: "button", label: "Payer", isSubmit: true, formHasPassword: false, submitLabel: "Payer" };

  it("allows a harmless click", async () => {
    const p = scripted({ role: "link", label: "Voir plus", isSubmit: false, formHasPassword: false, submitLabel: "" });
    await expect(guardAction(p, { backendNodeId: 3, action: "click" })).resolves.toBeUndefined();
  });

  it("refuses an irreversible click with an actionable message", async () => {
    const p = scripted(pay);
    const err = await guardAction(p, { backendNodeId: 3, action: "click" }).catch((e) => e);
    expect(err).toBeInstanceOf(RiskRefusedError);
    expect(err.name).toBe("RiskRefusedError");
    expect(err.message).toMatch(/click/);
    expect(err.message).toMatch(/Payer/);
    expect(err.message).toMatch(/ask the user, then retry with --confirm \/ confirm: true/);
    expect(err.reason).toBeTruthy();
  });

  it("lets a confirmed action through without even looking at the page", async () => {
    const p = scripted(pay);
    await guardAction(p, { backendNodeId: 3, action: "click", confirm: true });
    expect(p.calls).toHaveLength(0);
  });

  it("refuses Enter in a password form and names the key", async () => {
    const p = scripted({ role: "textbox", label: "", isSubmit: true, formHasPassword: true, submitLabel: "Log in" });
    const err = await guardAction(p, { action: "press", key: "Enter" }).catch((e) => e);
    expect(err).toBeInstanceOf(RiskRefusedError);
    expect(err.message).toMatch(/Enter/);
    expect(err.message).toMatch(/password field/);
  });

  it("does not look at the page for keys other than Enter", async () => {
    const p = scripted(pay);
    await guardAction(p, { action: "press", key: "ArrowDown" });
    expect(p.calls).toHaveLength(0);
  });

  it("propagates a failure to inspect the target instead of letting the action through", async () => {
    const p = new FakePage();
    p.handle("DOM.resolveNode", () => {
      throw new Error("No node with given id found");
    });
    await expect(guardAction(p, { backendNodeId: 9, action: "click" })).rejects.toThrow(/No node/);
  });
});
