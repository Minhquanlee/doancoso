document.addEventListener('DOMContentLoaded', ()=>{
  const qtyInputs = document.querySelectorAll('input[name="qty[]"], input[name="qty"]');
  function updateLine(input){
    const tr = input.closest('tr');
    const priceCell = tr.querySelector('td:nth-child(3)');
    const unit = parseInt(tr.dataset.unit || tr.querySelector('.unit-price')?.textContent.replace(/[^0-9]/g,'')||0);
    const q = parseInt(input.value)||0;
    priceCell.textContent = (unit * q).toLocaleString() + ' VND';
    // update total
    const totalEl = document.querySelector('#cart-total');
    if (totalEl) {
      let sum = 0;
      document.querySelectorAll('tbody tr').forEach(r=>{
        const p = r.querySelector('td:nth-child(3)').textContent.replace(/[^0-9]/g,'');
        sum += parseInt(p)||0;
      });
      totalEl.textContent = sum.toLocaleString() + ' VND';
    }
  }
  qtyInputs.forEach(i=>{
    i.addEventListener('change', ()=>updateLine(i));
    i.addEventListener('input', ()=>updateLine(i));
  });
});